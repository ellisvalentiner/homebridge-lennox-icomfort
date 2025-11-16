import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LennoxiComfortPlatform } from './platform';

import { API } from 'homebridge';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LennoxiComfortPlatform);
};
