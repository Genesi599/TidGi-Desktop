/**
 * Shared preset filter strings for TiddlyWeb sync.
 *
 * Exported so both the UI panel (chips) and the clone-from-server workflow
 * reference the same canonical values — prevents silent drift when one side
 * is updated and the other isn't.
 *
 * The keys here are also the i18n suffix (EditWorkspace.TiddlyWebFilterPreset*)
 * used by the UI to render each chip label.
 */

/** Never sync TidGi's own conflict-backup tiddlers — or we'd sync our syncs. */
const ALWAYS_EXCLUDED = '[prefix[$:/sync/]]';

/** Transient UI state that changes on every click — worthless to sync. */
const TRANSIENT = '[prefix[$:/temp/]] [prefix[$:/state/]] [prefix[$:/HistoryList]]';

/** Plugin / theme / language / boot bodies — per-device install, not content. */
const PLUGIN_BODIES = '[prefix[$:/plugins/]] [prefix[$:/themes/]] [prefix[$:/languages/]] [prefix[$:/boot/]] [prefix[$:/core]]';

/** Only TW core & boot — always risky to sync across versions. Plugin /
 *  theme / language bodies are allowed through. */
const TW_CORE_ONLY = '[prefix[$:/boot/]] [prefix[$:/core]]';

/**
 * Only skip TidGi's own conflict backups + transient UI state. Everything
 * else (including any server-provided system tiddler — `$:/SiteTitle`,
 * `$:/palette`, custom CSS, plugin tiddlers...) syncs.
 */
export const FILTER_PRESET_FULL_MIRROR = `${TRANSIENT} ${ALWAYS_EXCLUDED}`;

/**
 * Content + user settings: like full-mirror but ALSO skips plugin bodies.
 * Recommended when local and remote TW versions differ — lets each side
 * keep its own plugin install independent of the other.
 */
export const FILTER_PRESET_CONTENT_AND_SETTINGS = `${TRANSIENT} ${PLUGIN_BODIES} ${ALWAYS_EXCLUDED}`;

/**
 * Content + user settings + plugins/themes/languages: sync plugin bodies so
 * that installing a plugin locally propagates to the remote server (and vice
 * versa). Still skips TW core/boot since those are tightly tied to the local
 * tiddlywiki npm package version and shouldn't cross devices.
 *
 * Use case: you want plugins installed in TidGi to show up on the server too
 * (or the other way round) without having to manually copy `.tid` files.
 */
export const FILTER_PRESET_CONTENT_SETTINGS_AND_PLUGINS = `${TRANSIENT} ${TW_CORE_ONLY} ${ALWAYS_EXCLUDED}`;

/**
 * Safest: skip ALL system tiddlers. Historical TidGi default. Use against
 * third-party servers where you don't want to accidentally touch anything
 * outside user content.
 */
export const FILTER_PRESET_CONTENT_ONLY = '[prefix[$:/]]';
