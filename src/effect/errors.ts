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

/**
 * The library route was asked for an action it doesn't have. Answered with 404;
 * the action name stays out of the message.
 */
export class UnknownActionError extends Schema.TaggedError<UnknownActionError>()(
  "UnknownActionError",
  {}
) {
  override get message() {
    return "Unknown action."
  }
}

/** The input was refused. `message` is written for the user and is shown. */
export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  { message: Schema.String }
) {}

/**
 * A call to Google's APIs failed. `operation` names the Google method
 * (`files.get`, never an ID) and `status` is Google's HTTP status, absent when
 * no response arrived.
 *
 * Without `userMessage` the error is internal: the message deliberately
 * doesn't match the prefixes `publicErrorMessage` lets through. A caller that
 * wants the person to read why sets `userMessage` to a constant sentence;
 * never Google's own text.
 */
export class DriveApiError extends Schema.TaggedError<DriveApiError>()(
  "DriveApiError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Int),
    userMessage: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {
  override get message() {
    if (this.userMessage !== undefined) return this.userMessage
    return this.status === undefined
      ? `Drive API ${this.operation} failed`
      : `Drive API ${this.operation} failed (${this.status})`
  }
}

/**
 * Google refused to share, read or create a folder for a reason the person can
 * act on. `code` says which: `scope` (reconnect Google), `not-allowed`,
 * `not-found`, or `unavailable` (Google answered with something else). The
 * message is a constant sentence written for the user.
 */
export class DriveAccessError extends Schema.TaggedError<DriveAccessError>()(
  "DriveAccessError",
  {
    code: Schema.Literals(["scope", "not-allowed", "not-found", "unavailable"]),
    message: Schema.String,
  }
) {}

/**
 * The person's Google token is missing or unusable, so they have to reconnect
 * Google Drive in settings. Answered with the message below.
 */
export class DriveReconnectError extends Schema.TaggedError<DriveReconnectError>()(
  "DriveReconnectError",
  { cause: Schema.optional(Schema.Defect()) }
) {
  override get message() {
    return "Reconnect Google Drive in settings."
  }
}
