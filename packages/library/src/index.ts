// The library: <root>/YYYY/MM/<slug>-<id>/ capture folders and library.db, the SQLite FTS5
// index rebuilt from them.
export { ensureIndex, FTS_COLUMNS, indexEntry, openIndex, rebuildIndex, removeIndexed, SCHEMA_VERSION, setIndexedTags, type RebuildReport } from "./db.ts";
export {
  captureFolder,
  DB_FILE,
  DEFAULT_LIBRARY_DIR,
  LIBRARY_ENV,
  listCaptureFolders,
  readCaptureFolder,
  resolveLibraryDir,
  scanLibrary,
  slugify,
  type FolderEntry,
  type Skipped,
} from "./layout.ts";
export { AlreadySavedError, openLibrary, type ImportFileOptions, type ImportHtmlOptions, type Library, type LibraryOptions, type SaveOptions } from "./library.ts";
export { findPage, listFacets, listPages, QueryError, searchPages, toFtsQuery, type Facet, type Facets, type Filters, type PageRecord, type SearchHit, type SearchOptions } from "./search.ts";
export { archiveText, MAX_TEXT, readerText } from "./text.ts";
export { LATEST, previousVersion, urlKey, versionsOf, type VersionRef } from "./versions.ts";
