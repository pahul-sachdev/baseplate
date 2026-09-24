/**
 * Set artwork. A separate file from ports.ts on purpose: the engine has no use for images, so
 * this is a UI-facing capability and the engine's port surface stays exactly as it was.
 */

export interface CatalogImage {
  setNumber: string;
  /** Null means "asked, none available" — a real answer, not a failure. */
  imageUrl: string | null;
  name: string | null;
  year: number | null;
  theme: string | null;
}

export interface CatalogImageProvider {
  readonly name: string;
  getImage(setNumber: string): Promise<CatalogImage>;
}
