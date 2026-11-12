import { Schema } from "effect"

/** A database operation failed; `operation` names it, `cause` is the driver's. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  }
) {
  override get message() {
    return `Database operation ${this.operation} failed`
  }
}

/** A named lock was still held elsewhere when its wait ran out. */
export class LockBusyError extends Schema.TaggedError<LockBusyError>()(
  "LockBusyError",
  {
    operation: Schema.String,
    lock: Schema.String,
  }
) {
  override get message() {
    return `Lock for ${this.operation} is busy`
  }
}

/** A schema migration could not be applied. */
export class MigrationError extends Schema.TaggedError<MigrationError>()(
  "MigrationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}
