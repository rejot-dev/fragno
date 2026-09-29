import { useState } from "react";

import { WizardStepper } from "./wizard-stepper";

export default { title: "Navigation/Wizard stepper" };

const steps = [
  { title: "Source", description: "Pick where data comes from" },
  { title: "Transform", description: "Shape the records", helper: "Optional" },
  { title: "Review", description: "Confirm and install" },
];

export function Interactive() {
  const [currentStep, setCurrentStep] = useState(1);
  return <WizardStepper steps={steps} currentStep={currentStep} onStepChange={setCurrentStep} />;
}

export function ReadOnly() {
  return <WizardStepper steps={steps} currentStep={2} />;
}
