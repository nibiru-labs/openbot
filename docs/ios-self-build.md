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
```

React Native Skia needs no separate install step. CocoaPods copies its libraries from the
`react-native-skia-apple-*` packages. The [mobile README](../apps/mobile/README.md) lists the other
iOS commands and the release steps.

## 2. Set Bundle Identifier and Signing

The default bundle identifier `run.openbot.mobile` requires official project certificates. You must set a unique identifier:

1. Open `apps/mobile/app.json`.
2. Change `expo.ios.bundleIdentifier` to a unique identifier (for example, `com.example.openbot.mobile`).
3. For a Personal Team, remove `expo.ios.associatedDomains` and remove these complete entries from `expo.plugins`, including their option objects:
   - `./plugins/with-share-target`
   - `expo-widgets`
   - `./plugins/with-notification-service`
   - `expo-notifications`
4. Regenerate the iOS project so that old extension targets and entitlements do not remain. The clean prebuild deletes and recreates `apps/mobile/ios`; save any native changes first:
   ```bash
   cd apps/mobile
   bunx expo prebuild --platform ios --clean
   cd ../..
   ```
5. Open `apps/mobile/ios/OpenBot.xcworkspace` in Xcode. Under the app target's **Signing & Capabilities**, select your personal team and remove any remaining capabilities that the team cannot sign, such as App Groups, Associated Domains, or Push Notifications.

These changes disable the share extension, widgets, notification service extension, push notifications, associated links, and any removed capabilities. Changing the extension identifiers alone does not remove their App Group entitlement.

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

With a paid Apple Developer Program membership, you can create a local production `.ipa` for TestFlight:

From the repository root:

```bash
bun run mobile:ios:build:local
```

Or from `apps/mobile`:

```bash
bun run ios:build:local
```

Upload the resulting `/private/tmp/openbot-testflight.ipa` to App Store Connect, then distribute it through TestFlight. Do not use this store-distribution IPA for direct device installation.

## 5. Connect to a Self-Hosted Server

The mobile app connects to self-hosted OpenBot servers with a Mobile Connect QR code.

1. On a systemd server, run these commands with `sudo`. The control socket is accessible only to
   the service user and root:
   ```bash
   sudo openbot login
   ```
   In Docker, run `docker exec -it <container> openbot login` instead.
2. Generate the pairing QR code in the terminal:
   ```bash
   sudo openbot mobile-connect
   ```
   In Docker, run `docker exec -it <container> openbot mobile-connect` instead.
3. Open the OpenBot app on your iPhone.
4. Tap **Scan QR code** and scan the QR code displayed in the server terminal.

The app pairs with the server account and connects over WebRTC and Signal. See [self-hosted servers](self-hosted-server.md) for server configuration.
