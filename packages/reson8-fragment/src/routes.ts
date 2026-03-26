import { defineRoutes } from "@fragno-dev/core";

import { reson8FragmentDefinition } from "./definition";
import { authRoutesFactory, reson8AuthTokenSchema, type Reson8AuthToken } from "./routes/auth";
import {
  customModelRoutesFactory,
  reson8CreateCustomModelInputSchema,
  reson8CustomModelSchema,
  reson8ListCustomModelsOutputSchema,
  type Reson8CreateCustomModelInput,
  type Reson8CustomModel,
  type Reson8ListCustomModelsOutput,
} from "./routes/custom-models";
import {
  prerecordedRoutesFactory,
  reson8BinaryBodySchema,
  reson8PrerecordedQueryParameterNames,
  reson8PrerecordedTranscriptionSchema,
  reson8PrerecordedWordSchema,
  type Reson8BinaryBody,
  type Reson8PrerecordedQuery,
  type Reson8PrerecordedTranscription,
  type Reson8PrerecordedWord,
} from "./routes/prerecorded";
import { reson8ErrorSchema, type Reson8Error } from "./routes/shared";

export { authRoutesFactory, customModelRoutesFactory, prerecordedRoutesFactory };

export const reson8RoutesFactory = defineRoutes(reson8FragmentDefinition).create((context) => [
  ...authRoutesFactory(context),
  ...customModelRoutesFactory(context),
  ...prerecordedRoutesFactory(context),
]);

export {
  reson8AuthTokenSchema,
  reson8BinaryBodySchema,
  reson8CreateCustomModelInputSchema,
  reson8CustomModelSchema,
  reson8ErrorSchema,
  reson8ListCustomModelsOutputSchema,
  reson8PrerecordedQueryParameterNames,
  reson8PrerecordedTranscriptionSchema,
  reson8PrerecordedWordSchema,
};

export type {
  Reson8AuthToken,
  Reson8BinaryBody,
  Reson8CreateCustomModelInput,
  Reson8CustomModel,
  Reson8Error,
  Reson8ListCustomModelsOutput,
  Reson8PrerecordedQuery,
  Reson8PrerecordedTranscription,
  Reson8PrerecordedWord,
};
