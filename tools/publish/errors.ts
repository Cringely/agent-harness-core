// The four ways a tools/publish command ends without success (#274). cli.ts maps each to an exit
// code by type, never by message: PublishRefusal is 2 (a gate refused, nothing new was published),
// UsageError is 1 (bad arguments), PublishError is 1 (a dependency failed mid-run, and a step may
// already have happened, and its message says which), and AfterWriteError is 4 (review-merge stopped,
// by a refusal or an error, after it had already written to GitHub, and its message names each write).
// Every message is written by this tool and names a class of problem, never the text that tripped it.

export class PublishRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefusal";
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

// review-merge raises this for anything that stops it after its first GitHub write (the App review
// the reviewer posts, a bypass reason comment, the merge), so exit 2 keeps meaning nothing new was
// published. written lists those writes in order, and the message names them before the cause.
export class AfterWriteError extends Error {
  readonly written: readonly string[];
  constructor(written: readonly string[], cause: string) {
    super(`already written to GitHub: ${written.join(", ")}. Then stopped: ${cause}`);
    this.name = "AfterWriteError";
    this.written = [...written];
  }
}
