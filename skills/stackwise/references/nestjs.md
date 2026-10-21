# NestJS

Runtime items (event loop, pg pools, streams, `trust proxy`, CORS) are in [nodejs.md](nodejs.md);
status codes, paging and idempotency in [api-design.md](api-design.md).

## Checklist

### Validation and DTOs
- [ ] A `ValidationPipe` is bound (`APP_PIPE` provider or `app.useGlobalPipes`) with `whitelist: true` and `forbidNonWhitelisted: true`; without a pipe, DTO decorators are types only and any JSON reaches the service.
- [ ] Bodies are typed as DTO classes: `@Body() body: any`, an interface or `Record<string, unknown>` has no runtime metatype and skips validation.
- [ ] With `whitelist`, a DTO property that has no class-validator decorator is silently stripped: a new field without `@IsString()`/`@IsOptional()` always arrives `undefined`.
- [ ] Nested objects have `@ValidateNested()` + `@Type(() => Dto)`; arrays add `{ each: true }` and `@IsArray()`; optional ones also `@IsOptional()`. Without `@Type` the nested object is not validated against its class.
- [ ] An array body (`@Body() items: ItemDto[]`) is not validated per item by `ValidationPipe`; use `ParseArrayPipe({ items: ItemDto })` or wrap it in a DTO.
- [ ] Route params: `@Param('id') id: number` is still a string unless `transform: true` or `ParseIntPipe`/`ParseUUIDPipe` is applied; `id === 5` is false.
- [ ] `enableImplicitConversion` turns the query string `'false'` into `true` for a `boolean` field; use `@Transform(({ value }) => value === 'true')`.
- [ ] Update DTOs come from `PartialType(CreateDto)` (keeps the validators); a hand-copied DTO without decorators strips every field under `whitelist`.
- [ ] e2e tests bootstrap the same global pipes, guards and filters as `main.ts` (or register them as `APP_*` providers), or tests pass on behaviour production does not have.

### Auth: guards and metadata
- [ ] A new controller or route has the guard its siblings have (`@UseGuards(...)` or a global `APP_GUARD`); with neither it is public.
- [ ] A global guard honours `@Public()` through `reflector.getAllAndOverride(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])`; the key in `SetMetadata` and in the guard is the same constant.
- [ ] `@Public()` on a controller class opens every route in it, including ones added later; prefer it per handler.
- [ ] Guards check roles; ownership is checked in the query (`where: { id, ownerId: user.id }`). A role guard alone leaves IDOR.
- [ ] A guard that returns `false` gives 403; one that must give 401 throws `UnauthorizedException`.
- [ ] `useGlobalGuards(new AuthGuard())` in `main.ts` cannot inject services and is skipped by tests built from the module; prefer `{ provide: APP_GUARD, useClass: AuthGuard }`.

### Pipeline order and binding
- [ ] Order is middleware → guards → interceptors (before) → pipes → handler → interceptors (after) → exception filters. Code in an interceptor or pipe cannot protect what a guard already let through, and a guard cannot see pipe-transformed input.
- [ ] Within a kind, global runs before controller before route; filters resolve route-first. A route-level guard, pipe or interceptor adds to a global one; it does not replace it.
- [ ] An interceptor returns `next.handle()` (piped); the observable is lazy, so if it is not returned the handler never runs.
- [ ] `CacheInterceptor` keys by URL only: on a per-user GET, user B receives user A's cached response. Override `trackBy` or do not cache it.
- [ ] Throttler behind a proxy needs `trust proxy` on the Express adapter, or every client shares one limit (see [nodejs.md](nodejs.md)).

### DI scopes and providers
- [ ] `Scope.REQUEST` bubbles up: every controller and provider that injects a request-scoped provider becomes request-scoped and is rebuilt per request. Flag it on hot paths without a reason.
- [ ] Per-request data is not stored on a default-scoped (singleton) service field (`this.currentUser = user`); concurrent requests overwrite it.
- [ ] `@Inject(REQUEST)` providers are not used from `@Cron`, queue processors, gateways or `onModuleInit`: there is no request there.
- [ ] Lifecycle hooks (`onModuleInit`, `onModuleDestroy`) never run on request-scoped providers, including ones made request-scoped by a dependency.
- [ ] Circular imports: extract the shared part into its own module; `forwardRef(() => X)` on both sides is the last resort, and neither constructor uses the other. "Nest can't resolve dependencies of X (?)" at boot, or an `undefined` from a barrel `index.ts`, is the cue.
- [ ] Async providers: `useFactory` lists its dependencies in `inject` in argument order; async setup (connect, warm-up) lives in the factory or `onModuleInit`, not as a floating promise in a constructor.

### Responses and serialization
- [ ] `@Exclude()` works only when a class instance is returned and `ClassSerializerInterceptor` is bound; a Prisma result, a spread `{ ...user }` or `JSON.parse` output sends `passwordHash`.
- [ ] `@Res()` switches the route to manual mode: the return value is ignored, interceptors cannot map it, and a path that does not call `res.send` hangs. Use `@Res({ passthrough: true })` to set a cookie or header.
- [ ] A webhook that verifies a signature reads `req.rawBody` (`NestFactory.create(AppModule, { rawBody: true })`), not a re-serialised `@Body()`.

### Errors and exception filters
- [ ] Do not flag a missing try/catch in controllers: Nest maps `HttpException` subclasses to their status and unknown errors to a generic 500 without the message.
- [ ] Not-found and conflict cases throw `NotFoundException`/`ConflictException`; `catch { return null }` turns a database outage into a 200 with `null`.
- [ ] `new HttpException(err.message, 500)` or a catch-all filter that echoes `exception.message` leaks internals for non-HTTP errors.
- [ ] A `@Catch()` filter keeps the status of `HttpException`s (`exception.getStatus()`); mapping everything to 500 turns every 400/404 into a 500.
- [ ] A filter that calls `response.json(...)` breaks under the Fastify adapter; use `HttpAdapterHost` and `httpAdapter.reply`.
- [ ] Filters cover the request pipeline only: errors in `@Cron`, `@OnEvent` and queue handlers need their own catch and log.

### Data and transactions
- [ ] Inside `prisma.$transaction(async (tx) => ...)` every query uses `tx`; a call on `this.prisma` or another service's injected client runs outside it. Interactive transactions time out after 5 s by default, so no HTTP calls inside.
- [ ] Inside `dataSource.transaction(async (manager) => ...)` every write uses `manager`; an injected `@InjectRepository` repo commits on its own. A manual `QueryRunner` is released in `finally`.
- [ ] TypeORM `synchronize: true` is never reachable in production config; it alters and drops columns to match entities. Schema changes go through migrations.

### Config and lifecycle
- [ ] `ConfigModule.forRoot` validates (`validationSchema` or `validate`) so a missing secret fails boot; without it `config.get<number>('PORT')` is a type cast and returns a string.
- [ ] `app.enableShutdownHooks()` is called when providers implement `onModuleDestroy`/`onApplicationShutdown`; otherwise SIGTERM skips them and connections are cut.

## ValidationPipe and DTOs

```ts
// ❌ No pipe: { "role": "admin" } and { "email": 42 } both reach usersService.create.
@Post() create(@Body() dto: CreateUserDto) { return this.users.create(dto); }

// ✅ Bound once, also active in tests that build from AppModule.
providers: [{ provide: APP_PIPE, useValue: new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, transform: true,
}) }],
```

```ts
// ❌ The nested address is a plain object: its @IsPostalCode never runs.
@ValidateNested() address: AddressDto;
// ✅
@ValidateNested() @Type(() => AddressDto) address: AddressDto;
@IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
```

## Global guard and @Public()

```ts
// ❌ Reads the handler only: @Public() on the controller class is ignored.
const isPublic = this.reflector.get(IS_PUBLIC_KEY, ctx.getHandler());
// ✅
const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
if (isPublic) return true;
```

## Ownership in the service

```ts
// ❌ @Roles('customer') passes; any customer reads any order by id.
findOne(id: string) { return this.prisma.order.findUnique({ where: { id } }); }
// ✅
findOne(id: string, user: User) {
  return this.prisma.order.findFirstOrThrow({ where: { id, customerId: user.id } });
}
```

## Request state and scopes

```ts
// ❌ Singleton field: two concurrent requests swap tenants.
@Injectable() export class AuditService {
  tenantId: string;
  setTenant(id: string) { this.tenantId = id; }
}
// ✅ Pass it as an argument, or read it from a ClsService/AsyncLocalStorage store per request.
log(tenantId: string, event: AuditEvent) { ... }
```

## Serialization leaks

```ts
// ❌ Prisma returns a plain object, so @Exclude on UserEntity.passwordHash never applies.
@Get(':id') findOne(@Param('id') id: string) { return this.prisma.user.findUnique({ where: { id } }); }
// ✅ Return an instance (with ClassSerializerInterceptor bound), or select only public fields.
@Get(':id') async findOne(@Param('id') id: string) {
  return new UserEntity(await this.prisma.user.findUniqueOrThrow({ where: { id } }));
}
```

## @Res() and manual mode

```ts
// ❌ @Res() without passthrough: the returned object is never sent; the request hangs.
@Post('login') login(@Body() dto: LoginDto, @Res() res: Response) {
  res.cookie('sid', this.auth.session(dto));
  return { ok: true };
}
// ✅
@Post('login') login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) { ... }
```

## Transactions

```ts
// ❌ The decrement runs on the injected client, outside the transaction: if the
//    transaction fails, the order rolls back but the stock stays decremented.
await this.prisma.$transaction(async (tx) => {
  await tx.order.create({ data });
  await this.inventory.decrement(data.sku); // uses this.prisma internally
});
// ✅ Pass tx down: this.inventory.decrement(data.sku, tx).
```

## Async providers and config

```ts
// ❌ No `inject`: config is undefined and the factory throws at boot.
{ provide: REDIS, useFactory: (config: ConfigService) => new Redis(config.get('REDIS_URL')) }
// ✅
{ provide: REDIS, inject: [ConfigService],
  useFactory: (config: ConfigService) => new Redis(config.getOrThrow('REDIS_URL')) }

// ✅ Boot fails on a missing or malformed variable.
ConfigModule.forRoot({ isGlobal: true, validationSchema: Joi.object({ DATABASE_URL: Joi.string().uri().required() }) });
```

## Exception filters

```ts
// ❌ Every error, including a 404 NotFoundException, becomes a 500 with its raw message.
@Catch() export class AllFilter implements ExceptionFilter {
  catch(e: Error, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(500).json({ message: e.message });
  }
}
// ✅ Keep HttpException statuses; log unknown errors, answer with a generic body.
const status = e instanceof HttpException ? e.getStatus() : 500;
```

## Shutdown hooks

```ts
// ❌ PrismaService implements onModuleDestroy, but SIGTERM never calls it.
const app = await NestFactory.create(AppModule);
await app.listen(3000);
// ✅
app.enableShutdownHooks();
```
