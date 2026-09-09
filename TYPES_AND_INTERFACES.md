# Types and interfaces

## Type inventory and conventions

The backend uses Zod schemas for runtime HTTP validation and TypeScript aliases/interfaces for compile-time relationships. Zod inferred aliases describe data after validation. Prisma supplies generated model/query types. Express declaration merging adds application fields to Request.

The major flow is:

~~~mermaid
flowchart LR
  HTTP[HTTP body/query] --> Zod[Zod safeParse or parse]
  Zod --> Inputs[Inferred input types]
  Inputs --> Routes[Route/service calls]
  Routes --> Prisma[Prisma model/query types]
  Prisma --> Domain[Hash payload, activity, verification types]
  Domain --> Response[Response types and JSON]
~~~

Routes do not currently use the ApiResponse aliases as enforced return types; they call Express response methods directly.

## src/types/index.ts

### Runtime schemas and inferred inputs

#### IngestEventSchema

- **Kind:** exported Zod object schema.
- **Purpose:** validates POST /v1/events body.
- **Inferred alias:** IngestEventInput.
- **Used by:** validateBody in events.ts; createAuditLogEntry input; event route cast.
- **Properties:**

| Property | Inferred value | Required | Meaning |
|---|---|---|---|
| actorId | string | Yes | Actor identifier; 1 to 255 characters |
| actorType | string | Yes | Open actor classification; 1 to 100 characters |
| action | string | Yes | Action label; 1 to 255 characters |
| resourceId | string | Yes | Affected resource identifier; 1 to 255 characters |
| resourceType | string | Yes | Resource classification; 1 to 100 characters |
| metadata | Record<string, unknown> | No | Object-only metadata; serialized form must be at most 10 KB |
| ipAddress | string | No | Zod IP string |
| userAgent | string | No | User-agent string; maximum 500 characters |
| idempotencyKey | string | No | Retry/deduplication token; 1 to 255 characters |

metadata is null-normalized by the event route before storage/hash creation. Zod object parsing removes unknown keys by default.

#### SearchEventsBaseSchema

- **Kind:** private Zod object schema.
- **Purpose:** common validation base for search and export.
- **Properties:** optional actorId, actorType, action, resourceId, resourceType, startDate, endDate; page default 1/max 1000; limit default 50/min 1/max 100.
- **Date values:** startDate/endDate are Zod datetime strings before routes convert them to Date.
- **Reuse:** extended/refined into SearchEventsSchema and ExportEventsSchema.

#### isValidDateRange(data: object with optional startDate/endDate): boolean

- **Kind:** private function with an inline structural parameter type.
- **Purpose:** shared Zod refinement predicate.
- **Logic:** when both values exist, constructs Date objects, returns false if end is earlier or span exceeds 90 days. When one side is absent, it returns true.
- **Callers:** SearchEventsSchema and ExportEventsSchema construction.

#### SearchEventsSchema and SearchEventsInput

- **Schema purpose:** validates GET /v1/events query.
- **Alias kind:** SearchEventsInput is a type alias inferred with z.infer.
- **Shape:** the base fields above, with page and limit guaranteed numbers after defaulting/coercion.
- **Used by:** search route query cast and buildEventWhere.

#### ExportEventsSchema and ExportEventsInput

- **Schema purpose:** validates GET /v1/export query.
- **Alias kind:** ExportEventsInput is inferred with z.infer.
- **Additional property:** format is json or csv and defaults to json.
- **Used by:** export route query cast and buildEventWhere.
- **Important relationship:** page and limit remain part of this inferred type because it extends the search base, although the export handler does not use them to paginate output.

#### RegisterAppSchema and RegisterAppInput

- **Schema purpose:** validates POST /v1/apps body.
- **Properties:** name required string 1 through 100; description optional string up to 500.
- **Alias kind:** RegisterAppInput is inferred with z.infer.
- **Current use:** the schema is used by validateBody. RegisterAppInput is exported but no current source function declares or consumes it.

### HashPayload

- **Kind:** exported interface.
- **Purpose:** exact logical value HMACed for an audit row.
- **Used by:** computeEntryHash parameter; buildHashPayload return; event insertion; verifyChain.
- **Properties:**

| Property | Type | Meaning |
|---|---|---|
| appId | string | Chain partition/application identity |
| sequenceNumber | number | Per-app entry order |
| actorId | string | Actor identifier |
| actorType | string | Actor classification |
| action | string | Action label |
| resourceId | string | Resource identifier |
| resourceType | string | Resource classification |
| metadata | Record<string, unknown> or null | Canonicalized metadata value |
| createdAt | string | ISO timestamp |

Property insertion order in buildHashPayload is important because computeEntryHash JSON-stringifies the object. This interface intentionally has no ipAddress, userAgent, idempotencyKey, entryHash, or previousHash fields.

### VerificationResult

- **Kind:** exported discriminated union type alias.
- **Purpose:** output of verifyChain and optional verification-job result.
- **Discriminant:** valid.
- **Valid branch:** valid true, entriesChecked number, durationMs number.
- **Invalid branch:** valid false, entriesChecked number, durationMs number, tamperedAt object with sequenceNumber number and entryId string.
- **Used by:** hashChain return type; VerifyJob runtime-schema result shape is structurally equivalent.

### API response types

#### ApiSuccess<T>

- **Kind:** exported generic interface.
- **Properties:** success literal true; data generic T.
- **Purpose:** describes intended successful response envelope.

#### ApiError

- **Kind:** exported interface.
- **Properties:** success literal false; error object with message string, code string, statusCode number, optional details unknown.
- **Purpose:** describes intended error envelope.

#### ApiResponse<T>

- **Kind:** exported generic union alias of ApiSuccess<T> or ApiError.
- **Purpose:** represents either response shape.
- **Current use:** no current route function is annotated with or returns this alias directly.

The true/false literal fields make this a discriminated union for TypeScript consumers.

### ActivityEntry

- **Kind:** exported interface.
- **Purpose:** Redis activity member and activity endpoint representation.
- **Used by:** activityCache functions and new-event cache write.
- **Properties:** id, actorId, actorType, action, resourceId, resourceType are strings; metadata is Record<string, unknown> or null; createdAt is ISO string.
- **Relationship:** it is a selected/transformed subset of AuditLog. It excludes hashes, idempotency key, IP address, and user agent.

### AuthenticatedRequest

- **Kind:** exported intersection alias of Express Request and required auditApp: App.
- **Purpose:** represents a request after successful API-key authentication.
- **Current use:** exported but not used as a current route parameter type. Route code instead uses req.auditApp! after middleware order guarantees authentication.

### AsyncHandler

- **Kind:** exported function type alias.
- **Definition:** Request, Response, NextFunction -> Promise<unknown>.
- **Purpose:** constrains handlers accepted/returned by asyncHandler.
- **Used by:** asyncHandler implementation and route callbacks through inference.

## src/types/express.d.ts

### Express.Request declaration merge

- **Kind:** global interface extension of Express Request.
- **Runtime source:** none; this file changes TypeScript checking only.
- **Properties:**

| Property | Type | Set by | Meaning |
|---|---|---|---|
| id | string | requestId | Correlation ID alias |
| requestId | string | requestId | Correlation ID used by logging/error handler |
| auditApp | optional App authorization data without apiKey | apiKeyAuth | Authenticated application for protected routes |

The optional auditApp correctly reflects general Request values before authentication. id/requestId are declared required globally even though only requests that passed requestId have them at runtime; app.ts installs it before all routes.

## Route-local types and schemas

### src/routes/verify.ts

#### VerificationResultSchema

- **Kind:** private Zod schema.
- **Purpose:** runtime-checks the result field stored in a Redis verification job.
- **Shape:** valid boolean, entriesChecked number, durationMs number, optional tamperedAt containing number sequenceNumber and string entryId.
- **Relationship:** permissive valid boolean shape rather than a Zod discriminated union; it structurally accepts either branch of VerificationResult.

#### VerifyJobSchema

- **Kind:** private Zod schema.
- **Purpose:** validates Redis job JSON before it is returned by polling.
- **Properties:** UUID jobId; string appId; status pending/complete/failed; string startedAt; optional completedAt; optional result matching VerificationResultSchema; optional error string.

#### VerifyJob

- **Kind:** private alias inferred from VerifyJobSchema.
- **Used by:** getVerifyJobKey/saveVerifyJob/runVerifyJob and both verification route callbacks.
- **Meaning:** all persisted temporary job state.

### src/routes/search.ts

#### ActivityQuerySchema inferred value

ActivityQuerySchema is private; no named alias is declared. The activity handler uses z.infer<typeof ActivityQuerySchema> in a local intersection cast. It contains required-after-default limit: number, produced by a coerced integer with range 1 through 50.

### src/routes/export.ts

No custom named type is declared. The handler uses ExportEventsInput, imported from src/types/index.ts.

## Middleware-local types

### src/middleware/validate.ts: ValidatedRequest

- **Kind:** private intersection type.
- **Definition role:** Request with body unknown and query unknown.
- **Purpose:** permits assignment of Zod result.data back to a request field inside generic validation middleware.
- **Scope:** implementation-only type; no caller receives it.

### src/middleware/errorHandler.ts: AppError

AppError is a class rather than an interface. Its instance properties are statusCode number, code string, and isOperational boolean. The error handler accepts Error intersected with Partial<AppError>, allowing it to inspect operational properties on arbitrary thrown errors. See [error handling](MIDDLEWARE.md#final-error-middleware).

### src/middleware/auth.ts

No custom public type is declared. The cached JSON value is parsed as an untyped value, checked structurally through property access, then spread into a value assigned to req.auditApp. This relies on the declaration-merged Prisma App type rather than a dedicated cache-entry type.

## Service-local types

### src/services/alertService.ts: AlertPayload

- **Kind:** private interface.
- **Properties:** subject string; htmlContent string.
- **Purpose:** limits sendAlert to a subject and HTML content pair.
- **Used by:** sendAlert parameter; created by sendTamperAlert and sendAnomalyAlert.
- **Storage relationship:** it is sent directly to Brevo and is not persisted by this code.

### src/services/analyticsService.ts

#### withAnalyticsCache<T>

This private function is generic over T. Its compute parameter returns Promise<T>; its cache read is asserted as T after JSON.parse; its result is JSON-stringified and returned as T. The generic lets volume, actor, and action aggregations retain distinct result shapes.

The raw volume-query type is Array of objects containing date: string and count: bigint. Conversion to number occurs before return. Top actors use a local asserted array type because groupBy is cast to any. These are local structural types, not exported aliases.

### src/services/hashChain.ts

The buildHashPayload parameter is an inline structural object type containing App/audit fields and createdAt: Date; it returns HashPayload. verifyChain returns VerificationResult. Buffer values used for timing-safe comparison are Node built-in types inferred from Buffer.from.

### src/services/activityCache.ts

Function parameters use exported ActivityEntry. getActivityFeed returns an inline promise object type containing entries: ActivityEntry[] and source literal union cache or database. The literal union allows route output to distinguish cache origin.

## Prisma and framework types used directly

| Type/mechanism | Where used | Meaning |
|---|---|---|
| PrismaClient | config/db.ts | Generated Prisma database client type. |
| App | types/index.ts, express declaration | Generated App model type used for req.auditApp. |
| Prisma.AuditLogWhereInput | search.ts | Generated filter-input type returned by buildEventWhere. |
| Prisma.AuditLogSelect | search.ts | eventPublicSelect uses satisfies to ensure its selected fields are valid. |
| Prisma.InputJsonValue | events.ts | Assertion applied to metadata for Prisma create data. |
| Prisma.TransactionIsolationLevel.Serializable | events.ts | Generated enum value selecting transaction isolation. |
| Prisma.PrismaClientKnownRequestError | events.ts | Runtime error class used for P2034/P2002 branches. |
| Request, Response, NextFunction | types, middleware, apps route | Express request lifecycle types. |
| ZodSchema | validation wrappers | Generic runtime schema input. |
| z.infer | types and route-local schemas | Infers TypeScript values produced by a Zod schema. |

## Type assertions and narrowing in current code

- globalThis is cast through unknown to a shape with optional Prisma client.
- validation middleware casts Request to ValidatedRequest before replacing body/query.
- protected routes use req.auditApp! rather than narrowing, relying on mount order.
- event route casts req.body to IngestEventInput after validation.
- metadata is cast to Prisma.InputJsonValue or undefined for Prisma create.
- database JSON values are cast to Record<string, unknown> or null when becoming ActivityEntry/hash input.
- search/export query values are intersection-cast after validation.
- eventPublicSelect uses the safer satisfies operator rather than a broad assertion.
- analytics casts groupBy to any, then asserts the expected group result array.
- verification polling parses JSON then uses safeParse for structural validation; invalid JSON itself throws before schema narrowing.

## Type flow by feature

### Event creation

Request body -> IngestEventSchema -> IngestEventInput -> createAuditLogEntry -> inline Prisma create data plus HashPayload -> generated AuditLog model -> explicit response object.

### Search/export

Request query -> SearchEventsSchema or ExportEventsSchema -> inferred input -> buildEventWhere returns Prisma.AuditLogWhereInput -> eventPublicSelect satisfies Prisma.AuditLogSelect -> serialized response/stream.

### Authentication

Express Request -> apiKeyAuth -> declaration-merged optional Request.auditApp without the stored API-key digest -> protected route non-null assertion.

### Verification

random UUID and route-built object -> VerifyJob inferred type -> Redis JSON -> JSON.parse -> VerifyJobSchema.safeParse -> polling response. verifyChain returns VerificationResult, which becomes the job result field.

For source-level callers and functions, see [SRC_CODE_REFERENCE.md](SRC_CODE_REFERENCE.md).
