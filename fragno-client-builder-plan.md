# FragnoClientBuilder Implementation Plan

## Overview

This plan outlines the implementation of a new `FragnoClientBuilder` interface that provides a
type-safe, fluent API for creating library clients with hooks. The goal is to eliminate the need to
pass `publicConfig` and `libraryConfig` repeatedly while ensuring full type safety.

## Current Architecture Analysis

### Current Flow

1. `createLibraryClient()` takes `publicConfig`, `libraryConfig`, and `clientConfig`
2. `clientConfig` contains manually created hooks using `createRouteQueryHook()`
3. Each hook creation requires passing the same configs repeatedly
4. No compile-time validation of route paths or hook names

### Current Chatno Implementation

```typescript
export function createChatnoClient(publicConfig: ChatnoConfig & FragnoPublicClientConfig = {}) {
  const aiConfigRoute = libraryConfig.routes[3]; // Manual array indexing - fragile!

  const clientConfig = {
    hooks: {
      useAiConfig: createRouteQueryHook(publicConfig, libraryConfig, aiConfigRoute),
    },
  } as const;

  return createLibraryClient(publicConfig, libraryConfig, clientConfig);
}
```

## Requirements Analysis

### Core Requirements

1. ✅ **No repeated config passing**: Builder should encapsulate `publicConfig` and `libraryConfig`
2. ✅ **Type-safe interface**: All route paths and hook names should be compile-time validated
3. ✅ **GET routes only**: Only GET routes can create hooks (mutations will be separate)
4. ✅ **Path-based hook generation**: Hooks created based on route paths
5. ✅ **Named hooks**: `addHook()` takes explicit hook name parameter
6. ✅ **Strongly typed result**: `build()` returns object with all hooks properly typed

### Future Requirements

- Similar builder for mutations (`.api` instead of `.hooks`)
- Support for non-GET HTTP methods in mutation builder

## Implementation Plan

### Step 1: Define TypeScript Utility Types

Create utility types to extract and manipulate route information:

```typescript
// Extract only GET routes from library config
type ExtractGetRoutes<T extends readonly FragnoRouteConfig[]> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<infer Path, infer Input, infer Output>
    ? T[K]["method"] extends "GET"
      ? FragnoRouteConfig<Path, Input, Output>
      : never
    : never;
}[keyof T][];

// Extract route paths for type validation
type ExtractRoutePaths<T extends readonly FragnoRouteConfig[]> = {
  [K in keyof T]: T[K] extends FragnoRouteConfig<infer Path, any, any>
    ? T[K]["method"] extends "GET"
      ? Path
      : never
    : never;
}[keyof T];

// Generate hook type mapping
type GenerateHookTypes<T extends readonly FragnoRouteConfig[]> = {
  [HookName: string]: FragnoClientHook<any>;
};
```

**Location**: `packages/fragno/src/client/builder-types.ts`

### Step 2: Implement FragnoClientBuilder Class

Create a fluent builder interface:

```typescript
export class FragnoClientBuilder<
  TLibraryConfig extends FragnoLibrarySharedConfig,
  THooks extends Record<string, FragnoClientHook<any>> = {},
> {
  constructor(
    private publicConfig: FragnoPublicClientConfig,
    private libraryConfig: TLibraryConfig,
  ) {}

  addHook<THookName extends string, TPath extends ExtractRoutePaths<TLibraryConfig["routes"]>>(
    name: THookName,
    path: TPath,
  ): FragnoClientBuilder<
    TLibraryConfig,
    THooks & {
      [K in THookName]: FragnoClientHook<ExtractOutputSchema<TLibraryConfig["routes"], TPath>>;
    }
  > {
    // Implementation details
  }

  build(): THooks {
    // Return the built hooks object
  }
}
```

**Key Features**:

- Generic type parameters track library config and accumulated hooks
- `addHook()` validates path exists in GET routes
- Return type accumulates hook types for full type safety
- `build()` returns strongly typed hooks object

**Location**: `packages/fragno/src/client/client-builder.ts`

### Step 3: Update createLibraryClient Interface

```typescript
// New overload using builder
export function createLibraryClient<TLibraryConfig extends FragnoLibrarySharedConfig>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
  builderFn: (
    builder: FragnoClientBuilder<TLibraryConfig>,
  ) => FragnoClientBuilder<TLibraryConfig, any>,
): ReturnType<ReturnType<typeof builderFn>["build"]>;
```

**Location**: `packages/fragno/src/mod.ts`

### Step 4: Create Builder Factory Function

Add a convenience function for creating builders:

```typescript
export function createClientBuilder<TLibraryConfig extends FragnoLibrarySharedConfig>(
  publicConfig: FragnoPublicClientConfig,
  libraryConfig: TLibraryConfig,
): FragnoClientBuilder<TLibraryConfig> {
  return new FragnoClientBuilder(publicConfig, libraryConfig);
}
```

**Location**: `packages/fragno/src/client/client.ts`

### Step 5: Update Chatno Implementation

Refactor the chatno client creation to use the new builder:

```typescript
export function createChatnoClient(publicConfig: ChatnoConfig & FragnoPublicClientConfig = {}) {
  return createLibraryClient(publicConfig, libraryConfig, (builder) =>
    builder.addHook("useAiConfig", "/ai-config"),
  );
}
```

**Benefits**:

- No more manual array indexing
- Compile-time validation of route path
- Type-safe hook name
- Automatic hook type inference

### Step 6: Export New API

Update the main module exports:

```typescript
// Add to packages/fragno/src/mod.ts
export { FragnoClientBuilder, createClientBuilder } from "./client/client-builder";

// Add to packages/fragno/src/client/client.ts
export { FragnoClientBuilder } from "./client-builder";
```

## Type Safety Features

### Compile-Time Validations

1. **Route Path Validation**: Only existing GET route paths are allowed
2. **Hook Name Validation**: Hook names are tracked in type system
3. **Output Schema Inference**: Hook types automatically inferred from route schemas
4. **Method Filtering**: Only GET routes are available for hook creation

### Runtime Validations

1. **Route Existence**: Verify route exists in library config
2. **Method Validation**: Ensure route is GET method
3. **Duplicate Hook Names**: Prevent overwriting existing hook names

## Migration Strategy

### Phase 1: Implement New API (Backward Compatible)

- Add new builder classes and functions
- Keep existing `createLibraryClient` signature
- Update chatno to use new pattern

### Phase 2: Deprecation Warnings

- Add deprecation warnings to old pattern
- Update documentation to recommend new pattern
- Provide migration guide

### Phase 3: Breaking Change (Future)

- Remove old `createLibraryClient` overload
- Simplify implementation

## Future Enhancements

### Mutation Builder

Similar pattern for non-GET routes:

```typescript
export function createChatnoClient(publicConfig = {}) {
  return createLibraryClient(
    publicConfig,
    libraryConfig,
    (builder) => builder.addHook("useAiConfig", "/ai-config").addMutation("echo", "/echo"), // Future: mutations
  );
}

// Usage:
const client = createChatnoClient();
client.hooks.useAiConfig; // GET hooks
client.api.echo; // POST/PUT/etc mutations
```

### Advanced Features

- Query parameter type inference
- Path parameter extraction
- Custom hook options (polling, caching, etc.)
- Hook composition and dependencies

## Implementation Timeline

1. **Day 1**: Implement utility types and builder class
2. **Day 2**: Update createLibraryClient and add tests
3. **Day 3**: Refactor chatno implementation and validate
4. **Day 4**: Documentation and example updates
5. **Day 5**: Integration testing and polish

## Success Criteria

- ✅ No more repeated config passing
- ✅ Full compile-time type safety for paths and hook names
- ✅ Only GET routes can create hooks
- ✅ Strongly typed final hooks object
- ✅ Backward compatibility maintained
- ✅ Clean, intuitive API surface
- ✅ Comprehensive test coverage
- ✅ Updated examples and documentation

## Files to Modify/Create

### New Files

- `packages/fragno/src/client/builder-types.ts` - Type utilities
- `packages/fragno/src/client/client-builder.ts` - Builder implementation
- `packages/fragno/src/client/client-builder.test.ts` - Tests

### Modified Files

- `packages/fragno/src/mod.ts` - Update createLibraryClient
- `packages/fragno/src/client/client.ts` - Add factory function
- `packages/chatno/src/index.ts` - Use new builder pattern
- `examples/react-router-example/app/routes/home.tsx` - Updated usage

This plan provides a comprehensive roadmap for implementing the new `FragnoClientBuilder` interface
while maintaining backward compatibility and ensuring full type safety.
