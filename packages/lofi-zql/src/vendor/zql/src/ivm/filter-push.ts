// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zql/src/ivm/filter-push.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import {unreachable} from '../../../shared/src/asserts.ts';
import type {Row} from '../../../zero-protocol/src/data.ts';
import {ChangeIndex} from './change-index.ts';
import {ChangeType} from './change-type.ts';
import type {Change} from './change.ts';
import {maybeSplitAndPushEditChange} from './maybe-split-and-push-edit-change.ts';
import type {InputBase, Output} from './operator.ts';
import type {Stream} from './stream.ts';

export function* filterPush(
  change: Change,
  output: Output,
  pusher: InputBase,
  predicate?: (row: Row) => boolean,
): Stream<'yield'> {
  if (!predicate) {
    yield* output.push(change, pusher);
    return;
  }
  switch (change[ChangeIndex.TYPE]) {
    case ChangeType.ADD:
    case ChangeType.REMOVE:
      if (predicate(change[ChangeIndex.NODE].row)) {
        yield* output.push(change, pusher);
      }
      break;
    case ChangeType.CHILD:
      if (predicate(change[ChangeIndex.NODE].row)) {
        yield* output.push(change, pusher);
      }
      break;
    case ChangeType.EDIT:
      yield* maybeSplitAndPushEditChange(change, predicate, output, pusher);
      break;
    default:
      unreachable(change);
  }
}
