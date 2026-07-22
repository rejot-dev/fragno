import { useState } from "react";

import type { Categorization, Category, LayoutProps, RankedTester } from "@jsonforms/core";
import { and, categorizationHasCategory, rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch } from "@jsonforms/react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { withJsonFormsLayoutProps } from "../jsonforms-hocs";
import { createUiSchemaElementKeys } from "../util/ui-schema-keys";

const getTabValue = (index: number) => `tab-${index}`;

export const ShadcnCategorizationLayout = ({
  uischema,
  schema,
  path,
  enabled,
  visible,
  renderers,
  cells,
}: LayoutProps) => {
  const categorization = uischema as Categorization;
  const categories = (categorization.elements || []) as Category[];
  const [activeTab, setActiveTab] = useState(() => getTabValue(0));

  if (!visible) {
    return null;
  }

  if (categories.length === 0) {
    return null;
  }

  const categoryKeys = createUiSchemaElementKeys(categories);
  const categoryElementKeys = categories.map((category) =>
    createUiSchemaElementKeys(category.elements ?? []),
  );

  return (
    <Card>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <CardHeader>
          <TabsList className="w-full">
            {categories.map((category, index) => (
              <TabsTrigger key={categoryKeys[index]} value={getTabValue(index)} className="flex-1">
                {category.label || `Tab ${index + 1}`}
              </TabsTrigger>
            ))}
          </TabsList>
        </CardHeader>
        {categories.map((category, categoryIndex) => (
          <TabsContent
            key={categoryKeys[categoryIndex]}
            value={getTabValue(categoryIndex)}
            className="mt-0"
          >
            <CardContent>
              <div className="flex flex-col gap-4">
                {category.elements?.map((element, elementIndex) => (
                  <JsonFormsDispatch
                    key={`${path}-${getTabValue(categoryIndex)}-${categoryElementKeys[categoryIndex]?.[elementIndex]}`}
                    uischema={element}
                    schema={schema}
                    path={path}
                    enabled={enabled}
                    renderers={renderers}
                    cells={cells}
                  />
                ))}
              </div>
            </CardContent>
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
};

export const shadcnCategorizationLayoutTester: RankedTester = rankWith(
  1,
  and(uiTypeIs("Categorization"), categorizationHasCategory),
);

export const ShadcnCategorizationLayoutContext = withJsonFormsLayoutProps(
  ShadcnCategorizationLayout,
);
