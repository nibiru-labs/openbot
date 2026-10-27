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
3. If your Apple ID does not support App Groups, update or remove the extension identifiers in `plugins`:
   - `with-share-target` (`extensionBundleIdentifier` and `appGroupId`)
   - `expo-widgets` (`bundleIdentifier` and `groupIdentifier`)
   - `with-notification-service` (`bundleIdentifier` and `groupIdentifier`)
4. In Xcode, ensure your personal Apple ID team is selected for signing.

## 3. Development Build vs Release Build

- **`bun run dev:mobile`**:
  Runs the local desktop stack and the iOS simulator. Automatically pairs the desktop app and the simulator over Chrome DevTools Protocol (CDP) without a QR code scan. Use this command for simulator testing, not for physical iPhones.
- **Direct device build (`bun mobile:ios -- --device`)**:
  Builds and installs the development client directly on your connected iPhone. The app opens and connects to local or remote servers by camera QR scan.
- **Local release build (`bun run mobile:ios:build:local`)**:
  Builds a production `.ipa` file locally with EAS CLI without cloud compute. Outputs `/private/tmp/openbot-testflight.ipa`.

## 4. Build and Install on iPhone

Connect your unlocked iPhone to your Mac. Run from the repository root:

```bash
bun mobile:ios -- --device
```

Or from `apps/mobile`:

```bash
bun run ios -- --device
```

Expo prebuilds the native iOS project and installs the app onto your connected device. If Xcode prompts for code signing, select your personal team.

To create a local standalone production `.ipa`:

From the repository root:

```bash
bun run mobile:ios:build:local
```

Or from `apps/mobile`:

```bash
bun run ios:build:local
```

Install the resulting `/private/tmp/openbot-testflight.ipa` via Apple Configurator or Xcode (**Window > Devices and Simulators**).

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
