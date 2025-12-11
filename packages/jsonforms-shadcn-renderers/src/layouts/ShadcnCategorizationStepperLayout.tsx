import { useState } from "react";
import type { Categorization, Category, LayoutProps, RankedTester } from "@jsonforms/core";
import { and, categorizationHasCategory, optionIs, rankWith, uiTypeIs } from "@jsonforms/core";
import { JsonFormsDispatch, withJsonFormsLayoutProps } from "@jsonforms/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const ShadcnCategorizationStepperLayout = ({
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
  const [currentStep, setCurrentStep] = useState(0);

  if (!visible) {
    return null;
  }

  if (categories.length === 0) {
    return null;
  }

  const currentCategory = categories[currentStep];
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === categories.length - 1;

  const handleNext = () => {
    if (!isLastStep) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevious = () => {
    if (!isFirstStep) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleStepClick = (stepIndex: number) => {
    setCurrentStep(stepIndex);
  };

  return (
    <Card>
      <CardHeader>
        {/* Step Indicator */}
        <div className="flex w-full items-center">
          {categories.map((category, index) => (
            <div key={index} className="flex flex-1 items-center last:flex-none">
              <button
                type="button"
                onClick={() => handleStepClick(index)}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors",
                  index === currentStep
                    ? "bg-primary text-primary-foreground"
                    : index < currentStep
                      ? "bg-primary/20 text-primary hover:bg-primary/30"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
                title={category.label}
              >
                {index + 1}
              </button>
              {index < categories.length - 1 && (
                <div
                  className={cn(
                    "mx-2 h-0.5 flex-1",
                    index < currentStep ? "bg-primary/50" : "bg-muted",
                  )}
                />
              )}
            </div>
          ))}
        </div>
        {currentCategory.label && <CardTitle className="pt-4">{currentCategory.label}</CardTitle>}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {currentCategory.elements?.map((element, index) => (
            <JsonFormsDispatch
              key={`${path}-${currentStep}-${index}`}
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
      <CardFooter className="flex justify-between">
        <Button type="button" variant="outline" onClick={handlePrevious} disabled={isFirstStep}>
          Previous
        </Button>
        {!isLastStep && (
          <Button type="button" onClick={handleNext}>
            Next
          </Button>
        )}
      </CardFooter>
    </Card>
  );
};

export const shadcnCategorizationStepperLayoutTester: RankedTester = rankWith(
  2,
  and(uiTypeIs("Categorization"), categorizationHasCategory, optionIs("variant", "stepper")),
);

export const ShadcnCategorizationStepperLayoutContext = withJsonFormsLayoutProps(
  ShadcnCategorizationStepperLayout,
);
