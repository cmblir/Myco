/// <reference types="vite/client" />

/** Build date (YYYY-MM-DD), injected by vite.config.ts. */
declare const __BUILD_DATE__: string;
/** Version from package.json, injected by vite.config.ts. */
declare const __PACKAGE_VERSION__: string;
/**
 * True when tauri.conf.json carries a non-empty updater `pubkey`, i.e. this
 * build can verify a signed update. Injected by vite.config.ts.
 */
declare const __UPDATER_CONFIGURED__: boolean;
