/* -------------------------------
 * Errors
 * ------------------------------- */

export class MajikContactManagerError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactManagerError";
    this.cause = cause;
  }
}

export class MajikContactDirectoryError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactDirectoryError";
    this.cause = cause;
  }
}

export class MajikContactGroupManagerError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MajikContactGroupManagerError";
    this.cause = cause;
  }
}
