/**
 * Test suite for ServiceTxBuilder and HandlerTxBuilder type inference.
 * These tests verify that the builder pattern correctly infers types based on
 * which callbacks are set.
 *
 * NOTE: These are TYPE tests only. We test that the type inference is correct,
 * not the runtime behavior (which is covered by execute-unit-of-work.test.ts).
 */
import { describe, expectTypeOf, it } from "vitest";
import type { AnySchema } from "../../schema/create";
import type { TypedUnitOfWork } from "./unit-of-work";
import {
  ServiceTxBuilder,
  HandlerTxBuilder,
  type TxResult,
  serviceCalls,
  type ServiceBuilderMutateContext,
  type HandlerBuilderMutateContext,
  type BuilderTransformContextWithMutate,
  type BuilderTransformContextWithoutMutate,
  type ExtractServiceRetrieveResults,
  type ExtractServiceFinalResults,
  type AwaitedPromisesInObject,
} from "./execute-unit-of-work";

// =============================================================================
// Helper types for extracting TxResult type parameters
// =============================================================================

/**
 * Extract the final result type (TResult) from a TxResult
 */
type TxResultFinalType<T> = T extends TxResult<infer R, infer _> ? R : never;

/**
 * Extract the retrieve success result type from a TxResult
 */
type TxResultRetrieveType<T> = T extends TxResult<infer _, infer R> ? R : never;

// =============================================================================
// Test Schema
// =============================================================================

type TestSchema = AnySchema & {
  version: 1;
  entities: {
    users: { id: string; name: string; email: string };
    orders: { id: string; userId: string; total: number };
  };
};

// =============================================================================
// ServiceTxBuilder Type Tests
// =============================================================================

describe("ServiceTxBuilder type inference", () => {
  // We're testing types only, not runtime behavior
  // Using `as` casts to create builders without runtime dependencies

  describe("return type priority", () => {
    it("returns empty array when no callbacks are set", () => {
      // Create a builder type directly to test type inference
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      // The build() return type should be TxResult<[], []>
      type BuildResult = ReturnType<Builder["build"]>;
      // Extract just the type parameters to avoid complex internal type matching
      // Check length property to verify empty tuple without array method comparison issues
      expectTypeOf<TxResultFinalType<BuildResult>["length"]>().toEqualTypeOf<0>();
      expectTypeOf<TxResultRetrieveType<BuildResult>["length"]>().toEqualTypeOf<0>();
    });

    it("returns retrieve results when only retrieve is set", () => {
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        [{ id: string; name: string }[]], // same as retrieve since no transformRetrieve
        unknown,
        unknown,
        true, // HasRetrieve
        false,
        false,
        false,
        {}
      >;

      type BuildResult = ReturnType<Builder["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<
        [{ id: string; name: string }[]]
      >();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<
        [{ id: string; name: string }[]]
      >();
    });

    it("returns transformRetrieve result when transformRetrieve is set", () => {
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        { id: string; name: string } | null, // transformed result
        unknown,
        unknown,
        true, // HasRetrieve
        true, // HasTransformRetrieve
        false,
        false,
        {}
      >;

      type BuildResult = ReturnType<Builder["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{
        id: string;
        name: string;
      } | null>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<{
        id: string;
        name: string;
      } | null>();
    });

    it("returns mutate result when mutate is set (no transformRetrieve)", () => {
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        [{ id: string; name: string }[]], // raw retrieve results since no transformRetrieve
        { created: true; id: string }, // mutate result
        unknown,
        true, // HasRetrieve
        false, // NO transformRetrieve
        true, // HasMutate
        false,
        {}
      >;

      type BuildResult = ReturnType<Builder["build"]>;
      // Final result type is the mutate return type
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{
        created: true;
        id: string;
      }>();
      // Retrieve success result is the raw retrieve results (no transformRetrieve)
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<
        [{ id: string; name: string }[]]
      >();
    });

    it("returns mutate result when mutate is set (with transformRetrieve)", () => {
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        { id: string; name: string } | null, // transformed
        { orderId: string }, // mutate result
        unknown,
        true, // HasRetrieve
        true, // HasTransformRetrieve
        true, // HasMutate
        false,
        {}
      >;

      type BuildResult = ReturnType<Builder["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{ orderId: string }>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<{
        id: string;
        name: string;
      } | null>();
    });

    it("returns transform result when transform is set", () => {
      type Builder = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        { id: string; name: string } | null,
        { orderId: string },
        { success: true; data: string }, // transform result
        true, // HasRetrieve
        true, // HasTransformRetrieve
        true, // HasMutate
        true, // HasTransform
        {}
      >;

      type BuildResult = ReturnType<Builder["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{
        success: true;
        data: string;
      }>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<{
        id: string;
        name: string;
      } | null>();
    });
  });

  describe("withServiceCalls type inference", () => {
    it("infers service call result types in mutate context", () => {
      type ServiceCall1 = TxResult<{ userId: string }, { userId: string }>;
      type ServiceCall2 = TxResult<number, number>;
      type ServiceCalls = readonly [ServiceCall1, ServiceCall2];

      type Builder = ServiceTxBuilder<
        TestSchema,
        ServiceCalls,
        [],
        [],
        string, // mutate result
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      // Get the mutate method's parameter type
      type MutateParam = Parameters<Builder["mutate"]>[0];
      type MutateCtx = Parameters<MutateParam>[0];

      // serviceIntermediateResult should be a tuple with the retrieve success results
      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ userId: string }, number]
      >();
    });

    it("handles optional service calls (undefined in tuple)", () => {
      type ServiceCall = TxResult<{ userId: string }, { userId: string }>;
      type ServiceCalls = readonly [ServiceCall, undefined];

      type Extracted = ExtractServiceRetrieveResults<ServiceCalls>;

      // Second element should be undefined
      expectTypeOf<Extracted>().toEqualTypeOf<readonly [{ userId: string }, undefined]>();
    });

    it("provides serviceIntermediateResult in transform with final results", () => {
      type ServiceCall = TxResult<{ finalData: string }, { retrieveData: string }>;
      type ServiceCalls = readonly [ServiceCall];

      type Builder = ServiceTxBuilder<
        TestSchema,
        ServiceCalls,
        [],
        [],
        { created: boolean },
        unknown,
        false,
        false,
        true, // HasMutate
        true, // HasTransform (we'll check its param type)
        {}
      >;

      // Get the transform method's parameter type
      type TransformParam = Parameters<Builder["transform"]>[0];
      type TransformCtx = Parameters<TransformParam>[0];

      // serviceResult contains final results
      expectTypeOf<TransformCtx["serviceResult"]>().toEqualTypeOf<
        readonly [{ finalData: string }]
      >();
      // serviceIntermediateResult contains retrieve success results
      expectTypeOf<TransformCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ retrieveData: string }]
      >();
    });
  });

  describe("context types", () => {
    it("ServiceBuilderMutateContext has correct shape", () => {
      type Ctx = ServiceBuilderMutateContext<TestSchema, string, readonly [], {}>;

      expectTypeOf<Ctx["uow"]>().toExtend<TypedUnitOfWork<TestSchema, [], unknown, {}>>();
      expectTypeOf<Ctx["retrieveResult"]>().toEqualTypeOf<string>();
      expectTypeOf<Ctx["serviceIntermediateResult"]>().toEqualTypeOf<readonly []>();
    });

    it("BuilderTransformContextWithMutate has mutateResult defined", () => {
      type Ctx = BuilderTransformContextWithMutate<
        string,
        { id: string },
        readonly [],
        readonly []
      >;

      expectTypeOf<Ctx["retrieveResult"]>().toEqualTypeOf<string>();
      expectTypeOf<Ctx["mutateResult"]>().toEqualTypeOf<{ id: string }>();
      expectTypeOf<Ctx["serviceIntermediateResult"]>().toEqualTypeOf<readonly []>();
      expectTypeOf<Ctx["serviceIntermediateResult"]>().toEqualTypeOf<readonly []>();
    });

    it("BuilderTransformContextWithoutMutate has mutateResult as undefined", () => {
      type Ctx = BuilderTransformContextWithoutMutate<string, readonly [], readonly []>;

      expectTypeOf<Ctx["retrieveResult"]>().toEqualTypeOf<string>();
      expectTypeOf<Ctx["mutateResult"]>().toEqualTypeOf<undefined>();
      expectTypeOf<Ctx["serviceIntermediateResult"]>().toEqualTypeOf<readonly []>();
      expectTypeOf<Ctx["serviceIntermediateResult"]>().toEqualTypeOf<readonly []>();
    });
  });

  describe("builder state tracking via type parameters", () => {
    it("builder with HasRetrieve=true returns retrieve results when no other callbacks", () => {
      type BuilderWithRetrieve = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]], // same as retrieve since no transformRetrieve
        unknown,
        unknown,
        true, // HasRetrieve = true
        false,
        false,
        false,
        {}
      >;

      type BuildResult = ReturnType<BuilderWithRetrieve["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<[{ id: string }[]]>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<[{ id: string }[]]>();
    });

    it("builder with HasTransformRetrieve=true returns transformed result", () => {
      type BuilderWithTransformRetrieve = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string }[]],
        { id: string } | null, // transformed
        unknown,
        unknown,
        true, // HasRetrieve
        true, // HasTransformRetrieve = true
        false,
        false,
        {}
      >;

      type BuildResult = ReturnType<BuilderWithTransformRetrieve["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{ id: string } | null>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<{ id: string } | null>();
    });

    it("builder with HasMutate=true returns mutate result", () => {
      type BuilderWithMutate = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]],
        { created: boolean }, // mutate result
        unknown,
        true,
        false,
        true, // HasMutate = true
        false,
        {}
      >;

      type BuildResult = ReturnType<BuilderWithMutate["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{ created: boolean }>();
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<[{ id: string }[]]>();
    });

    it("builder with HasTransform=true returns transform result", () => {
      type BuilderWithTransform = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [],
        [],
        { orderId: string },
        { success: boolean }, // transform result
        false,
        false,
        true,
        true, // HasTransform = true
        {}
      >;

      type BuildResult = ReturnType<BuilderWithTransform["build"]>;
      expectTypeOf<TxResultFinalType<BuildResult>>().toEqualTypeOf<{ success: boolean }>();
      // When HasMutate=true but no retrieve, the mutate result becomes the retrieve success result for dependents
      expectTypeOf<TxResultRetrieveType<BuildResult>>().toEqualTypeOf<{ orderId: string }>();
    });
  });
});

// =============================================================================
// HandlerTxBuilder Type Tests
// =============================================================================

describe("HandlerTxBuilder type inference", () => {
  describe("return type priority", () => {
    it("returns service final results when only withServiceCalls is set", () => {
      type ServiceCall = TxResult<{ data: string }, { data: string }>;

      type Builder = HandlerTxBuilder<
        readonly [ServiceCall],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      type ExecuteResult = ReturnType<Builder["execute"]>;
      // execute() returns a Promise of the service final results
      expectTypeOf<ExecuteResult>().toExtend<
        Promise<AwaitedPromisesInObject<readonly [{ data: string }]>>
      >();
    });

    it("returns mutate result when mutate is set", () => {
      type Builder = HandlerTxBuilder<
        readonly [],
        [],
        [],
        { orderId: string }, // mutate result
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type ExecuteResult = ReturnType<Builder["execute"]>;
      expectTypeOf<ExecuteResult>().toExtend<Promise<{ orderId: string }>>();
    });

    it("returns transform result when transform is set", () => {
      type Builder = HandlerTxBuilder<
        readonly [],
        [],
        [],
        { orderId: string },
        { success: true; orderId: string }, // transform result
        false,
        false,
        true, // HasMutate
        true, // HasTransform
        {}
      >;

      type ExecuteResult = ReturnType<Builder["execute"]>;
      expectTypeOf<ExecuteResult>().toExtend<Promise<{ success: true; orderId: string }>>();
    });
  });

  describe("context field names", () => {
    it("HandlerBuilderMutateContext has idempotencyKey and currentAttempt", () => {
      type Ctx = HandlerBuilderMutateContext<[], readonly [], {}>;

      expectTypeOf<Ctx["idempotencyKey"]>().toEqualTypeOf<string>();
      expectTypeOf<Ctx["currentAttempt"]>().toEqualTypeOf<number>();
      expectTypeOf<Ctx["forSchema"]>().toBeFunction();
      // Check length property to verify empty tuple without array method comparison issues
      expectTypeOf<Ctx["retrieveResult"]["length"]>().toEqualTypeOf<0>();
      expectTypeOf<Ctx["serviceIntermediateResult"]["length"]>().toEqualTypeOf<0>();
    });

    it("retrieve context in HandlerTxBuilder has correct type", () => {
      type Builder = HandlerTxBuilder<
        readonly [],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      // Get the retrieve parameter type
      type RetrieveParam = Parameters<Builder["retrieve"]>[0];
      type RetrieveCtx = Parameters<RetrieveParam>[0];

      expectTypeOf<RetrieveCtx["idempotencyKey"]>().toEqualTypeOf<string>();
      expectTypeOf<RetrieveCtx["currentAttempt"]>().toEqualTypeOf<number>();
      expectTypeOf<RetrieveCtx["forSchema"]>().toBeFunction();
    });

    it("transform context has serviceResult and serviceIntermediateResult", () => {
      type ServiceCall = TxResult<{ finalData: string }, { retrieveData: string }>;

      type Builder = HandlerTxBuilder<
        readonly [ServiceCall],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        true, // HasTransform
        {}
      >;

      type TransformParam = Parameters<Builder["transform"]>[0];
      type TransformCtx = Parameters<TransformParam>[0];

      expectTypeOf<TransformCtx["serviceResult"]>().toEqualTypeOf<
        readonly [{ finalData: string }]
      >();
      expectTypeOf<TransformCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ retrieveData: string }]
      >();
      expectTypeOf<TransformCtx["mutateResult"]>().toEqualTypeOf<undefined>();
    });
  });

  describe("withServiceCalls + mutate flow", () => {
    it("serviceIntermediateResult is available in mutate", () => {
      type ServiceCall = TxResult<number, { user: { id: string } }>;

      type Builder = HandlerTxBuilder<
        readonly [ServiceCall],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type MutateParam = Parameters<Builder["mutate"]>[0];
      type MutateCtx = Parameters<MutateParam>[0];

      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ user: { id: string } }]
      >();
    });

    it("widens serviceIntermediateResult when serviceCalls is a non-tuple array", () => {
      type Status = { status: string };
      type HistoryPage = { runNumber: number };
      type StatusCall = TxResult<Status, Status>;
      type RunNumberCall = TxResult<number, number>;
      type HistoryCall = TxResult<HistoryPage, HistoryPage>;

      // When serviceCalls are built dynamically (e.g. Array.from + spread),
      // the tuple shape is lost and results widen to a union array.
      type ServiceCalls = readonly (StatusCall | RunNumberCall | HistoryCall)[];

      type Builder = HandlerTxBuilder<
        ServiceCalls,
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type MutateParam = Parameters<Builder["mutate"]>[0];
      type MutateCtx = Parameters<MutateParam>[0];

      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly (Status | number | HistoryPage)[]
      >();
    });

    it("preserves tuple inference for dynamic serviceCalls when using helper", () => {
      type Status = { status: string };
      type HistoryPage = { runNumber: number };
      type StatusCall = TxResult<Status, Status>;
      type RunNumberCall = TxResult<number, number>;
      type HistoryCall = TxResult<HistoryPage, HistoryPage>;

      const statusCall = null as unknown as StatusCall;
      const runNumberCall = null as unknown as RunNumberCall;
      const historyCalls = [] as HistoryCall[];

      const calls = serviceCalls(statusCall, runNumberCall, ...historyCalls);

      expectTypeOf<typeof calls>().toEqualTypeOf<
        readonly [StatusCall, RunNumberCall, ...HistoryCall[]]
      >();

      type Builder = HandlerTxBuilder<
        typeof calls,
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type MutateParam = Parameters<Builder["mutate"]>[0];
      type MutateCtx = Parameters<MutateParam>[0];

      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [Status, number, ...HistoryPage[]]
      >();
    });
  });

  describe("retrieve + transformRetrieve flow", () => {
    it("transformRetrieve receives raw retrieve results", () => {
      type Builder = HandlerTxBuilder<
        readonly [],
        [{ id: string }, { id: string }], // retrieve results
        [{ id: string }, { id: string }],
        unknown,
        unknown,
        true, // HasRetrieve
        false,
        false,
        false,
        {}
      >;

      type TransformRetrieveParam = Parameters<Builder["transformRetrieve"]>[0];

      // First param is the raw retrieve results
      expectTypeOf<Parameters<TransformRetrieveParam>[0]>().toEqualTypeOf<
        [{ id: string }, { id: string }]
      >();
    });

    it("mutate receives transformed retrieve result when transformRetrieve is set", () => {
      type Builder = HandlerTxBuilder<
        readonly [],
        [{ id: string }[]],
        { id: string } | null, // transformed
        unknown,
        unknown,
        true, // HasRetrieve
        true, // HasTransformRetrieve
        true, // HasMutate
        false,
        {}
      >;

      type MutateParam = Parameters<Builder["mutate"]>[0];
      type MutateCtx = Parameters<MutateParam>[0];

      // retrieveResult is the transformed type
      expectTypeOf<MutateCtx["retrieveResult"]>().toEqualTypeOf<{ id: string } | null>();
    });
  });
});

// =============================================================================
// Helper Type Tests
// =============================================================================

describe("Helper type utilities", () => {
  describe("ExtractServiceRetrieveResults", () => {
    it("extracts retrieve success results from TxResult tuple", () => {
      type ServiceCalls = readonly [TxResult<number, string>, TxResult<boolean, { data: number }>];

      type Result = ExtractServiceRetrieveResults<ServiceCalls>;

      // Should extract the second type parameter (retrieve success result)
      expectTypeOf<Result>().toEqualTypeOf<readonly [string, { data: number }]>();
    });

    it("handles undefined in service calls", () => {
      type ServiceCalls = readonly [TxResult<number, string>, undefined];

      type Result = ExtractServiceRetrieveResults<ServiceCalls>;

      expectTypeOf<Result>().toEqualTypeOf<readonly [string, undefined]>();
    });

    it("handles empty service calls array", () => {
      type ServiceCalls = readonly [];

      type Result = ExtractServiceRetrieveResults<ServiceCalls>;

      expectTypeOf<Result>().toEqualTypeOf<readonly []>();
    });
  });

  describe("ExtractServiceFinalResults", () => {
    it("extracts final results from TxResult tuple", () => {
      type ServiceCalls = readonly [
        TxResult<{ id: number }, string>,
        TxResult<boolean, { data: number }>,
      ];

      type Result = ExtractServiceFinalResults<ServiceCalls>;

      // Should extract the first type parameter (final result)
      expectTypeOf<Result>().toEqualTypeOf<readonly [{ id: number }, boolean]>();
    });

    it("handles undefined in service calls", () => {
      type ServiceCalls = readonly [TxResult<number, string>, undefined];

      type Result = ExtractServiceFinalResults<ServiceCalls>;

      expectTypeOf<Result>().toEqualTypeOf<readonly [number, undefined]>();
    });

    it("handles empty service calls array", () => {
      type ServiceCalls = readonly [];

      type Result = ExtractServiceFinalResults<ServiceCalls>;

      expectTypeOf<Result>().toEqualTypeOf<readonly []>();
    });
  });
});

// =============================================================================
// Builder Method Parameter Type Tests
// =============================================================================

describe("ServiceTxBuilder method parameter types", () => {
  // Test with an initial builder type
  type InitialBuilder = ServiceTxBuilder<
    TestSchema,
    readonly [],
    [],
    [],
    unknown,
    unknown,
    false,
    false,
    false,
    false,
    {}
  >;

  describe("retrieve() callback parameter", () => {
    it("receives TypedUnitOfWork with correct schema", () => {
      type RetrieveCallback = Parameters<InitialBuilder["retrieve"]>[0];
      type UowParam = Parameters<RetrieveCallback>[0];

      // The UoW should be typed for TestSchema
      expectTypeOf<UowParam>().toExtend<TypedUnitOfWork<TestSchema, [], unknown, {}>>();
    });
  });

  describe("transformRetrieve() callback parameters", () => {
    // Builder with retrieve results set
    type BuilderWithRetrieve = ServiceTxBuilder<
      TestSchema,
      readonly [],
      [{ id: string; name: string }[]], // retrieve results
      [{ id: string; name: string }[]], // same since no transformRetrieve yet
      unknown,
      unknown,
      true, // HasRetrieve
      false,
      false,
      false,
      {}
    >;

    it("first param is raw retrieve results", () => {
      type TransformRetrieveCallback = Parameters<BuilderWithRetrieve["transformRetrieve"]>[0];
      type FirstParam = Parameters<TransformRetrieveCallback>[0];

      expectTypeOf<FirstParam>().toEqualTypeOf<[{ id: string; name: string }[]]>();
    });

    it("second param is service retrieve results", () => {
      // Builder with service calls
      type BuilderWithServices = ServiceTxBuilder<
        TestSchema,
        readonly [TxResult<number, { userId: string }>, TxResult<boolean, { count: number }>],
        [{ id: string }[]],
        [{ id: string }[]],
        unknown,
        unknown,
        true,
        false,
        false,
        false,
        {}
      >;

      type TransformRetrieveCallback = Parameters<BuilderWithServices["transformRetrieve"]>[0];
      type SecondParam = Parameters<TransformRetrieveCallback>[1];

      expectTypeOf<SecondParam>().toEqualTypeOf<readonly [{ userId: string }, { count: number }]>();
    });
  });

  describe("mutate() context parameter", () => {
    it("has uow typed for schema", () => {
      type MutateCallback = Parameters<InitialBuilder["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["uow"]>().toExtend<TypedUnitOfWork<TestSchema, [], unknown, {}>>();
    });

    it("has retrieveResult from retrieve results when no transformRetrieve", () => {
      type BuilderWithRetrieve = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        [{ id: string; name: string }[]], // same as TRetrieveResults
        unknown,
        unknown,
        true,
        false, // no transformRetrieve
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithRetrieve["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["retrieveResult"]>().toEqualTypeOf<[{ id: string; name: string }[]]>();
    });

    it("has retrieveResult from transformRetrieve when set", () => {
      type BuilderWithTransformRetrieve = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string; name: string }[]],
        { user: { id: string } } | null, // transformed
        unknown,
        unknown,
        true,
        true, // has transformRetrieve
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithTransformRetrieve["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["retrieveResult"]>().toEqualTypeOf<{ user: { id: string } } | null>();
    });

    it("has serviceResult from service calls", () => {
      type BuilderWithServices = ServiceTxBuilder<
        TestSchema,
        readonly [TxResult<string, { data: number[] }>],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithServices["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ data: number[] }]
      >();
    });
  });

  describe("transform() context parameter", () => {
    it("has mutateResult when HasMutate=true", () => {
      type BuilderWithMutate = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]],
        { created: boolean }, // mutate result
        unknown,
        true,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type TransformCallback = Parameters<BuilderWithMutate["transform"]>[0];
      type TransformCtx = Parameters<TransformCallback>[0];

      expectTypeOf<TransformCtx["mutateResult"]>().toEqualTypeOf<{ created: boolean }>();
    });

    it("has mutateResult as undefined when HasMutate=false", () => {
      type BuilderWithoutMutate = ServiceTxBuilder<
        TestSchema,
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]],
        unknown,
        unknown,
        true,
        false,
        false, // HasMutate = false
        false,
        {}
      >;

      type TransformCallback = Parameters<BuilderWithoutMutate["transform"]>[0];
      type TransformCtx = Parameters<TransformCallback>[0];

      expectTypeOf<TransformCtx["mutateResult"]>().toEqualTypeOf<undefined>();
    });

    it("has serviceResult with final results and serviceIntermediateResult with retrieve results", () => {
      type BuilderWithServices = ServiceTxBuilder<
        TestSchema,
        readonly [TxResult<{ finalValue: number }, { retrieveValue: string }>],
        [],
        [],
        { id: string },
        unknown,
        false,
        false,
        true,
        false,
        {}
      >;

      type TransformCallback = Parameters<BuilderWithServices["transform"]>[0];
      type TransformCtx = Parameters<TransformCallback>[0];

      // serviceResult has FINAL results
      expectTypeOf<TransformCtx["serviceResult"]>().toEqualTypeOf<
        readonly [{ finalValue: number }]
      >();
      // serviceIntermediateResult has RETRIEVE results
      expectTypeOf<TransformCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ retrieveValue: string }]
      >();
    });
  });
});

describe("HandlerTxBuilder method parameter types", () => {
  type InitialBuilder = HandlerTxBuilder<
    readonly [],
    [],
    [],
    unknown,
    unknown,
    false,
    false,
    false,
    false,
    {}
  >;

  describe("retrieve() callback parameter", () => {
    it("receives context with idempotencyKey and currentAttempt", () => {
      type RetrieveCallback = Parameters<InitialBuilder["retrieve"]>[0];
      type CtxParam = Parameters<RetrieveCallback>[0];

      expectTypeOf<CtxParam["idempotencyKey"]>().toEqualTypeOf<string>();
      expectTypeOf<CtxParam["currentAttempt"]>().toEqualTypeOf<number>();
      expectTypeOf<CtxParam["forSchema"]>().toBeFunction();
    });
  });

  describe("mutate() context parameter", () => {
    it("has idempotencyKey, currentAttempt, and forSchema", () => {
      type BuilderWithRetrieve = HandlerTxBuilder<
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]],
        unknown,
        unknown,
        true,
        false,
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithRetrieve["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["idempotencyKey"]>().toEqualTypeOf<string>();
      expectTypeOf<MutateCtx["currentAttempt"]>().toEqualTypeOf<number>();
      expectTypeOf<MutateCtx["forSchema"]>().toBeFunction();
    });

    it("has retrieveResult from retrieve", () => {
      type BuilderWithRetrieve = HandlerTxBuilder<
        readonly [],
        [{ id: string }[]],
        [{ id: string }[]],
        unknown,
        unknown,
        true,
        false,
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithRetrieve["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["retrieveResult"]>().toEqualTypeOf<[{ id: string }[]]>();
    });

    it("has serviceResult from service calls", () => {
      type BuilderWithServices = HandlerTxBuilder<
        readonly [TxResult<number, { user: { id: string } }>],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      type MutateCallback = Parameters<BuilderWithServices["mutate"]>[0];
      type MutateCtx = Parameters<MutateCallback>[0];

      expectTypeOf<MutateCtx["serviceIntermediateResult"]>().toEqualTypeOf<
        readonly [{ user: { id: string } }]
      >();
    });
  });

  describe("execute() return type", () => {
    it("returns Promise of mutate result when HasMutate=true", () => {
      type BuilderWithMutate = HandlerTxBuilder<
        readonly [],
        [],
        [],
        { orderId: string; success: boolean }, // mutate result
        unknown,
        false,
        false,
        true, // HasMutate
        false,
        {}
      >;

      type ExecuteResult = ReturnType<BuilderWithMutate["execute"]>;

      expectTypeOf<ExecuteResult>().toEqualTypeOf<Promise<{ orderId: string; success: boolean }>>();
    });

    it("returns Promise of transform result when HasTransform=true", () => {
      type BuilderWithTransform = HandlerTxBuilder<
        readonly [],
        [],
        [],
        { orderId: string },
        { success: true; order: { id: string } }, // transform result
        false,
        false,
        true,
        true, // HasTransform
        {}
      >;

      type ExecuteResult = ReturnType<BuilderWithTransform["execute"]>;

      expectTypeOf<ExecuteResult>().toEqualTypeOf<
        Promise<{ success: true; order: { id: string } }>
      >();
    });

    it("returns Promise of service final results when only withServiceCalls is set", () => {
      type BuilderWithServices = HandlerTxBuilder<
        readonly [TxResult<{ data: string }, unknown>, TxResult<number, unknown>],
        [],
        [],
        unknown,
        unknown,
        false,
        false,
        false,
        false,
        {}
      >;

      type ExecuteResult = ReturnType<BuilderWithServices["execute"]>;

      // Result is the awaited service final results tuple
      expectTypeOf<ExecuteResult>().toExtend<Promise<readonly [{ data: string }, number]>>();
    });
  });
});
