# Build and Install the iOS App

This document explains how to build and install the OpenBot iOS app on a physical iPhone with a personal Apple ID.

## Prerequisites

- macOS with Xcode 26.4 or newer.
- Node.js 24 or newer and Bun 1.4.2.
- CocoaPods (`pod --version`).
- An Apple ID added to Xcode (**Xcode > Settings > Accounts**).
- A physical iPhone with **Developer Mode** enabled (**Settings > Privacy & Security > Developer Mode**).
- Connect the iPhone to your Mac with a cable and trust the computer.

## 1. Prepare Dependencies

From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd apps/mobile setup:skia
```

`setup:skia` copies the React Native Skia native libraries required before CocoaPods runs.

## 2. Set Bundle Identifier and Signing

The default bundle identifier `run.openbot.mobile` requires official project certificates. You must set a unique identifier:

1. Open `apps/mobile/app.json`.
2. Change `expo.ios.bundleIdentifier` to a unique identifier (for example, `com.example.openbot.mobile`).
3. For a Personal Team, remove `expo.ios.associatedDomains` and remove these complete entries from `expo.plugins`, including their option objects:
   - `./plugins/with-share-target`
   - `expo-widgets`
   - `./plugins/with-notification-service`
   - `expo-notifications`
   For a paid Apple Developer team, either make the same removals or register identifiers and capabilities with that team. Changing only the main bundle identifier is not enough. If you keep the extensions, update all of these plugin options in `expo.plugins` to identifiers registered with your team:

   - `./plugins/with-share-target`: `ios.extensionBundleIdentifier` (`run.openbot.mobile.ShareExtension`) and `ios.appGroupId` (`group.run.openbot.mobile`).
   - `expo-widgets`: `bundleIdentifier` (`run.openbot.mobile.ExpoWidgetsTarget`) and `groupIdentifier` (`group.run.openbot.mobile`).
   - `./plugins/with-notification-service`: `bundleIdentifier` (`run.openbot.mobile.NotificationService`) and `groupIdentifier` (`group.run.openbot.mobile`).

   Use the same team-registered App Group identifier in all three group options. If you keep encrypted push notifications, also change `APP_GROUP` in `apps/mobile/src/features/push-notifications/push-notifications-native.ios.ts` to that identifier. The app uses this constant to write and remove the keys that the notification service extension reads. Changing the plugin options alone does not change the runtime constant. Verify encrypted push notifications on a physical device with your team's signing and push configuration; this guide does not establish that they work for a custom group.

   Register each extension bundle identifier and enable the required capabilities for the app and extensions. Configure or remove Associated Domains and Push Notifications if your team cannot use them. The other custom plugins, `./plugins/with-rocketsim` and `./plugins/with-notification-sounds`, do not define extension identifiers or App Groups.
4. Regenerate the iOS project so that old extension targets and entitlements do not remain. The clean prebuild deletes and recreates `apps/mobile/ios`; save any native changes first:
   ```bash
   cd apps/mobile
   bunx expo prebuild --platform ios --clean
   cd ../..
   ```
5. Open `apps/mobile/ios/OpenBot.xcworkspace` in Xcode. Under the app target's **Signing & Capabilities**, select your Apple team and remove any remaining capabilities that the team cannot sign, such as App Groups, Associated Domains, or Push Notifications.

The Personal Team removals disable the share extension, widgets, notification service extension, push notifications, associated links, and any removed capabilities. Changing the extension identifiers alone does not remove their App Group entitlement.

## 3. Development Build vs Release Build

- **`bun run dev:mobile`**:
  Runs the local desktop stack and the iOS simulator. Automatically pairs the desktop app and the simulator over Chrome DevTools Protocol (CDP) without a QR code scan. Use this command for simulator testing, not for physical iPhones.
- **Direct device build (`bun mobile:ios -- --device`)**:
  Builds and installs the development client directly on your connected iPhone. The app opens and connects to local or remote servers by camera QR scan.
- **Local production build (`bun run mobile:ios:build:local`)**:
  Builds a store-distribution `.ipa` locally with EAS CLI. TestFlight distribution requires a paid Apple Developer Program membership. This IPA cannot be installed directly with Xcode or Apple Configurator.

## 4. Build and Install on iPhone

Connect your unlocked iPhone to your Mac. Run from the repository root:

```bash
bun mobile:ios -- --device
```

Or from `apps/mobile`:

```bash
bun run ios -- --device
```

Expo builds and installs the development client onto your connected device. If Xcode prompts for code signing, select your personal team. Keep the Metro server running while you use the development build.

For a Personal Team, the provisioning profile expires seven days after it is issued. After it expires, rebuild and reinstall the app on the device. See [Apple's developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account/).

To create a local production `.ipa` for TestFlight, you need a paid Apple Developer Program membership and access to an EAS project. The checked-in `apps/mobile/app.json` points to the shared OpenBot project through `expo.owner` and `expo.extra.eas.projectId`. A paid Apple membership alone does not give you access to that project.

Sign in to your Expo account before you initialize a project or build. From `apps/mobile`, run:

```bash
bunx eas-cli@latest login
```

See the [EAS CLI reference](https://docs.expo.dev/eas/cli/). Then choose one of these options before the build:

- Get the required access to the existing OpenBot Expo project and its signing credentials from its owner.
- Use your own Expo account and project. In your local `apps/mobile/app.json`, set `expo.owner` to your Expo account, remove the existing `expo.extra.eas.projectId`, and remove the existing `expo.updates.url` so it does not point to the OpenBot project. From `apps/mobile`, run `bunx eas-cli@latest init` and follow the prompts to create or link your project. See the [EAS CLI reference](https://docs.expo.dev/eas/cli/#eas-projectinit).

You also need Apple signing credentials for the selected bundle identifier and team. An authorized Apple team member can create them, or an authorized Expo user can provide existing credentials. On an individual Apple Developer account, only the Account Holder can generate signing credentials. On an organization account, the Account Holder or Admin can generate them; an App Manager also needs access to Certificates, Identifiers, and Profiles. See [Expo's signing permissions guide](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/).

Then build the IPA:

From the repository root:

```bash
bun run mobile:ios:build:local
```

Or from `apps/mobile`:

```bash
bun run ios:build:local
```

The resulting `/private/tmp/openbot-testflight.ipa` is a local build artifact, not a TestFlight distribution. Upload it to App Store Connect, wait for Apple to process the build, and grant tester access through TestFlight. These are separate steps from the local build. Do not use this store-distribution IPA for direct device installation.

## 5. Connect to a Self-Hosted Server

The mobile app connects to self-hosted OpenBot servers with a Mobile Connect QR code.

1. On your self-hosted server, make sure you are signed in:
   ```bash
   openbot login
   ```
2. Generate the pairing QR code in the terminal:
   ```bash
   openbot mobile-connect
   ```
   (In Docker: `docker exec -it <container> openbot mobile-connect`)
3. Open the OpenBot app on your iPhone.
4. Tap **Scan QR code** and scan the QR code displayed in the server terminal.

The app pairs with the server account and connects over WebRTC and Signal. See [self-hosted servers](self-hosted-server.md) for server configuration.
