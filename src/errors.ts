export class JrnlError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "JrnlError";
  }
}

export class GitConflictError extends JrnlError {
  constructor(message = "Git histories conflict. Run `jrnl resolve-conflicts`.") {
    super(message, 3);
    this.name = "GitConflictError";
  }
}

export class IncompatibleSchemaError extends JrnlError {
  constructor(message: string) {
    super(message, 4);
    this.name = "IncompatibleSchemaError";
  }
}

export class SyncPendingError extends JrnlError {
  constructor(message: string) {
    super(message, 2);
    this.name = "SyncPendingError";
  }
}
