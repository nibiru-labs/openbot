// The real account service routes that host publishing uses, over a SQLite database file, for
// `scripts/host-publish-e2e.ts`. It serves sign-in, host registration and the member directory with
// the request handling of the Worker routes, and writes `{"port":<port>}` on one line when it
// listens. Development codes come back in the answers.
//
// Run: bun apps/auth-api/scripts/host-publish-server.ts <database path>
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { type DynamicRecord, isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { AuthService, AuthServiceError } from "../src/server/auth-service";
import { D1AuthRepository } from "../src/server/d1-auth-repository";
import { RemoteControlPlane, RemoteControlPlaneError } from "../src/server/remote-control-plane";
import { sqliteD1 } from "./sqlite-d1";

const SOURCE_IP = "127.0.0.1";
const databasePath = process.argv[2];
if (!databasePath) throw new Error("Pass the database path.");
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA foreign_keys = ON");

const ticketKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", ticketKeys.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", ticketKeys.privateKey);

const auth = new AuthService({
  repository: new D1AuthRepository(sqliteD1(database)),
  delivery: null,
  exposeDevelopmentCode: true,
});
const plane = new RemoteControlPlane(
  {
    DB: sqliteD1(database),
    REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "ticket-1" }),
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: "ticket-1" }] }),
    REMOTE_TICKET_KEY_ID: "ticket-1",
  },
  { now: () => Date.now(), schedule: () => undefined },
);

interface Answer {
  status: number;
  body?: unknown;
}

function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } };
}

function recordOf(value: unknown): DynamicRecord {
  return isDynamicRecord(value) ? value : {};
}

function readBody(request: IncomingMessage): Promise<DynamicRecord> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(chunks.length ? recordOf(JSON.parse(Buffer.concat(chunks).toString("utf8"))) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function route(request: IncomingMessage, body: DynamicRecord) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const token = /^Bearer (\S+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? null;
  const key = `${request.method} ${url.pathname}`;
  return Effect.gen(function* (): Effect.fn.Return<Answer, unknown> {
    if (key === "GET /health/live") return { status: 200, body: { status: "ok" } };
    if (key === "POST /v1/auth/email/start") {
      if (!isString(body.email)) return failure(400, "invalid_email", "Enter a valid email address.");
      const idempotencyKey = request.headers["idempotency-key"];
      return {
        status: 200,
        body: yield* auth.startEmailSignIn(
          body.email,
          SOURCE_IP,
          isString(idempotencyKey) ? idempotencyKey : undefined,
        ),
      };
    }
    if (key === "POST /v1/auth/email/verify") {
      if (!isString(body.challengeId) || !isString(body.code)) {
        return failure(400, "invalid_sign_in_code", "The sign-in code is invalid.");
      }
      return {
        status: 200,
        body: yield* auth.verifyEmailCode({
          challengeId: body.challengeId,
          code: body.code,
          sourceIp: SOURCE_IP,
          surface: "desktop",
        }),
      };
    }
    if (!token) return failure(401, "unauthorized", "Sign in is required.");
    if (key === "GET /v1/me") {
      const user = yield* auth.authenticate(token);
      return user ? { status: 200, body: user } : failure(401, "unauthorized", "The session is invalid.");
    }
    const user = yield* auth.authenticate(token);
    if (!user) return failure(401, "unauthorized", "The session is invalid.");
    if (key === "POST /v2/remote/hosts/register") {
      if (
        !isString(body.hostId) ||
        !isString(body.name) ||
        !isString(body.ownerMembershipId) ||
        !(body.rotateCredential === undefined || isBoolean(body.rotateCredential)) ||
        !(body.machineToken === undefined || isString(body.machineToken)) ||
        !(body.devicePublicKey === undefined || body.devicePublicKey === null || isString(body.devicePublicKey))
      ) {
        return failure(400, "invalid_remote_request", "The host registration is invalid.");
      }
      return {
        status: 201,
        body: yield* plane.registerHost(user, {
          hostId: body.hostId,
          name: body.name,
          ownerMembershipId: body.ownerMembershipId,
          devicePublicKey: body.devicePublicKey,
          rotateCredential: body.rotateCredential,
          machineToken: body.machineToken,
        }),
      };
    }
    const members = /^GET \/v2\/remote\/hosts\/([^/]+)\/members\/$/u.exec(key);
    if (members?.[1]) {
      return { status: 200, body: { members: yield* plane.listMembers(user.id, decodeURIComponent(members[1])) } };
    }
    return failure(404, "not_found", "Not found.");
  }).pipe(
    Effect.catchIf(
      (error) => error instanceof AuthServiceError,
      (error) => Effect.succeed(failure(error.status, error.code, error.message)),
    ),
    Effect.catchIf(
      (error) => error instanceof RemoteControlPlaneError,
      (error) => Effect.succeed(failure(error.status, error.code, error.message)),
    ),
  );
}

function send(response: ServerResponse, answer: Answer) {
  response.writeHead(answer.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
}

const server = createServer((request, response) => {
  readBody(request)
    .then((body) => Effect.runPromise(route(request, body)))
    .then(
      (answer) => send(response, answer),
      () => send(response, failure(500, "internal_error", "Internal error.")),
    );
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("The account server has no port.");
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
process.on("SIGTERM", () => {
  server.close();
  database.close();
  process.exit(0);
});
