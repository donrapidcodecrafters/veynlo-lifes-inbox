import { AppRegistry } from "react-native";
import ShareExtension from "./src/share-extension";

// IMPORTANT: this exact string is required by expo-share-extension's native side.
AppRegistry.registerComponent("shareExtension", () => ShareExtension);
