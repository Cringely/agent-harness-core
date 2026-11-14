// The three ways a tools/publish command ends without success (#274). cli.ts maps each to an exit
// code by type, never by message: PublishRefusal is 2 (a gate refused, nothing new was published),
// UsageError is 1 (bad arguments), PublishError is 1 (a dependency failed mid-run, and a step may
// already have happened, and its message says which). Every message is written by this tool and names
// a class of problem, never the text that tripped it.

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
