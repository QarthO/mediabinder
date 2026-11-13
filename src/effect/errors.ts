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

/** The request has no valid session. Answered with 401. */
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
  "AuthenticationError",
  {}
) {
  override get message() {
    return "Sign in to continue."
  }
}

/**
 * Something the caller asked for isn't there, or isn't theirs to see.
 * `resource` is a short noun such as "Tag", never user content: it is shown.
 */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "NotFoundError",
  { resource: Schema.String }
) {
  override get message() {
    return `${this.resource} not found.`
  }
}

/** The input was refused. `message` is written for the user and is shown. */
export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  { message: Schema.String }
) {}

/**
 * A call to Google's APIs failed. `status` is Google's HTTP status, absent
 * when no response arrived. Never shown to users as it is: the message
 * deliberately doesn't match the prefixes `publicErrorMessage` lets through.
 */
export class DriveApiError extends Schema.TaggedError<DriveApiError>()(
  "DriveApiError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    return this.status === undefined
      ? `Drive API ${this.operation} failed`
      : `Drive API ${this.operation} failed (${this.status})`
  }
}
