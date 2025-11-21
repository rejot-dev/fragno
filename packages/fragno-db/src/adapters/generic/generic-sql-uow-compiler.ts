import type { UOWCompiler } from "../../mod";
import type {
  RetrievalOperation,
  MutationOperation,
  CompiledMutation,
} from "../../query/unit-of-work";
import type { AnySchema } from "../../schema/create";

export abstract class GenericSQLUOWCompiler<TOutput> implements UOWCompiler<TOutput> {
  abstract compileMutationOperation(
    op: MutationOperation<AnySchema>,
  ): CompiledMutation<TOutput> | null;

  compileRetrievalOperation(op: RetrievalOperation<AnySchema>): TOutput | null {
    switch (op.type) {
      case "find":
        return this.compileFindOperation(op);
      default:
        throw new Error("not implemented");
    }
  }

  compileFindOperation(
    op: Extract<RetrievalOperation<AnySchema>, { type: "find" }>,
  ): TOutput | null {
    const { useIndex, orderByIndex, joins, after, before, pageSize, select, where } = op.options;
    return null;
  }
}
