# Expected findings: nestjs

Stacks the skill should detect: Node backend (NestJS, from the `@nestjs/*` imports), TypeScript. Required references: nodejs, nestjs, typescript, error-handling, security, testing. Optional: api-design. Must not load: react, nextjs, or any .NET reference.

## must

1. **Mass assignment through a non-whitelisting ValidationPipe** — `src/main.ts:8` registers `new ValidationPipe({ transform: true })` without `whitelist: true`, and `src/users/users.service.ts:18` passes the whole DTO to `repo.update`. Report it at either line; it is one finding.
   - Breaks when: a logged-in member sends `PATCH /users/me` with `{"displayName":"x","role":"admin"}`. The pipe keeps the undeclared `role` property, `repo.update({ id }, dto)` writes it, and the caller is now an admin. `emailVerified: true` works the same way.
   - Fix: `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, and map the allowed fields explicitly in the service (`repo.update({ id }, { displayName: dto.displayName, address: dto.address })`).

## should

2. **Nested DTO is never validated** — `src/users/dto/update-profile.dto.ts:24`. `address` has `@IsOptional()` but no `@ValidateNested()` and `@Type(() => AddressDto)`, so the `@IsString`/`@MaxLength` rules on `AddressDto` never run.
   - Breaks when: `{"address": {"street": 42, "city": "<200 KB string>"}}` or `{"address": "hello"}` is stored as-is in the `jsonb` column; readers that expect three strings crash or render garbage.
   - Fix: add `@ValidateNested()` and `@Type(() => AddressDto)` (and `@IsObject()`) to `address`.

## Acceptable extra findings (not required)

- `PATCH /users/me` with an empty body: TypeORM's `update` throws `UpdateValuesMissingError`, which surfaces as a 500 (should).
- No test for the new endpoint, including a test that `role` cannot be changed (testing.md; a should only if sibling endpoints are tested, otherwise a note).
- Horizontal: other DTOs or global settings may already whitelist; fold that into finding 1.

## Must not be reported

- `@Req()` instead of a custom `@CurrentUser()` decorator, or other style choices.
- Missing Swagger/OpenAPI decorators.
- Missing auth on `PATCH /users/me`: the controller-level `@UseGuards(JwtAuthGuard)` covers it.
