import { MOBILE_PLUGINS } from "../../marketplace/model/plugin-catalog.generated";
import { isMobileConnectorId } from "../../servers/model/connectors";

/** True when the mobile app knows how to connect this app id. */
export function marketplaceSuggestionKnown(appId: string): boolean {
  return isMobileConnectorId(appId) || MOBILE_PLUGINS.some((plugin) => plugin.slug === appId);
}
