/// <reference types="vite/client" />
import type { MojocodeDesktopApi } from '../shared/api.js';

declare global {
  interface Window {
    mojocode: MojocodeDesktopApi;
  }
}

export {};
