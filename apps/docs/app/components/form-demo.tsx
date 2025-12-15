import { useState, useEffect, type ComponentProps } from "react";
import { JsonForms } from "@jsonforms/react";
import { RuleEffect, type JsonSchema, type UISchemaElement } from "@jsonforms/core";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";
import { ClipboardList, MessageSquare, BarChart3, Settings, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

// =============================================================================
// CLIENT-SIDE JSONFORMS WRAPPER
// =============================================================================

// Hook to detect client-side rendering
function useIsClient() {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => {
    setIsClient(true);
  }, []);
  return isClient;
}

// Wrapper that only renders JsonForms on the client
// (JsonForms uses Ajv which requires `new Function()` - not available in Workers)
function ClientSideJsonForms(props: Omit<ComponentProps<typeof JsonForms>, "renderers" | "cells">) {
  const isClient = useIsClient();

  if (!isClient) {
    return <div className="h-32 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />;
  }

  return <JsonForms {...props} renderers={shadcnRenderers} cells={shadcnCells} />;
}

// =============================================================================
// SCHEMAS
// =============================================================================

// 1. Event Registration (Stepper)
const eventRegSchema: JsonSchema = {
  type: "object",
  properties: {
    firstName: { type: "string", title: "First Name" },
    lastName: { type: "string", title: "Last Name" },
    email: { type: "string", title: "Email Address", format: "email" },
    phone: { type: "string", title: "Phone Number" },
    ticketType: {
      type: "string",
      enum: ["general", "vip", "speaker"],
      title: "Ticket Type",
    },
    eventDate: { type: "string", format: "date", title: "Preferred Date" },
    dietary: { type: "string", title: "Dietary Requirements" },
  },
};

const eventRegUiSchema: UISchemaElement = {
  type: "Categorization",
  options: { variant: "stepper" },
  elements: [
    {
      type: "Category",
      label: "Personal",
      elements: [
        {
          type: "HorizontalLayout",
          elements: [
            { type: "Control", scope: "#/properties/firstName" },
            { type: "Control", scope: "#/properties/lastName" },
          ],
        },
        {
          type: "HorizontalLayout",
          elements: [
            {
              type: "Control",
              scope: "#/properties/email",
              options: { placeholder: "you@example.com" },
            },
            {
              type: "Control",
              scope: "#/properties/phone",
              options: { readonly: true, placeholder: "0800-CALL-ME-MAYBE" },
            },
          ],
        },
      ],
    },
    {
      type: "Category",
      label: "Ticket",
      elements: [
        { type: "Control", scope: "#/properties/ticketType", options: { format: "radio" } },
      ],
    },
    {
      type: "Category",
      label: "Details",
      elements: [
        { type: "Control", scope: "#/properties/eventDate" },
        { type: "Control", scope: "#/properties/dietary" },
      ],
    },
  ],
};

// 2. Feedback Form (Slider + Radio)
const feedbackSchema: JsonSchema = {
  type: "object",
  properties: {
    satisfaction: {
      type: "integer",
      title: "Overall Satisfaction",
      minimum: 0,
      maximum: 10,
      default: 5,
    },
    recommend: {
      type: "string",
      oneOf: [
        { const: "absolutely", title: "Absolutely" },
        { const: "likely", title: "Very Likely" },
        { const: "no-fam", title: "I don't talk about forms with friends or family" },
        { const: "definitely", title: "They already know" },
      ],
      title: "Would you recommend us?",
      description: "How likely are you to recommend us to friends or family?",
    },
  },
};

const feedbackUiSchema: UISchemaElement = {
  type: "VerticalLayout",
  elements: [
    { type: "Control", scope: "#/properties/satisfaction", options: { slider: true } },
    { type: "Control", scope: "#/properties/recommend", options: { format: "radio" } },
  ],
};

// 3. Quick Survey (Tabs)
const surveySchema: JsonSchema = {
  type: "object",
  properties: {
    // About You
    role: {
      type: "string",
      enum: ["developer", "designer", "manager", "other"],
      title: "Your Role",
    },
    industry: {
      type: "string",
      enum: ["tech", "finance", "healthcare", "education", "other"],
      title: "Industry",
    },
    // Experience
    experience: {
      type: "string",
      enum: ["0-1", "2-4", "5+"],
      title: "Years of Experience",
    },
    skillLevel: {
      type: "string",
      enum: ["beginner", "intermediate", "advanced"],
      title: "Skill Level",
    },
    joinBeta: { type: "boolean", title: "Join our beta program?" },
    // Team
    teamSize: {
      type: "string",
      enum: ["solo", "small", "medium", "large"],
      title: "Team Size",
    },
    remoteWork: {
      type: "string",
      enum: ["remote", "hybrid", "office"],
      title: "Work Style",
    },
    // Usage
    usageFrequency: {
      type: "string",
      enum: ["daily", "weekly", "monthly"],
      title: "How often would you use this?",
    },
    primaryUseCase: {
      type: "string",
      enum: ["prototyping", "production", "learning", "side-projects"],
      title: "Primary Use Case",
    },
  },
};

const surveyUiSchema: UISchemaElement = {
  type: "Categorization",
  elements: [
    {
      type: "Category",
      label: "About You",
      elements: [
        { type: "Control", scope: "#/properties/role" },
        { type: "Control", scope: "#/properties/industry" },
      ],
    },
    {
      type: "Category",
      label: "Experience",
      elements: [
        { type: "Control", scope: "#/properties/experience" },
        { type: "Control", scope: "#/properties/skillLevel" },
        { type: "Control", scope: "#/properties/joinBeta" },
      ],
    },
    {
      type: "Category",
      label: "Team",
      elements: [
        { type: "Control", scope: "#/properties/teamSize" },
        { type: "Control", scope: "#/properties/remoteWork" },
      ],
    },
    {
      type: "Category",
      label: "Usage",
      elements: [
        { type: "Control", scope: "#/properties/usageFrequency" },
        { type: "Control", scope: "#/properties/primaryUseCase" },
      ],
    },
  ],
};

// 5. Settings Panel (Groups + Toggles)
const settingsSchema: JsonSchema = {
  type: "object",
  properties: {
    // Notifications
    pushNotifications: { type: "boolean", title: "Push notifications" },
    emailNotifications: { type: "boolean", title: "Email notifications" },
    emailFrequency: {
      type: "string",
      title: "Email frequency",
      enum: ["hourly", "yearly", "decadely"],
    },
    smsNotifications: { type: "boolean", title: "SMS notifications" },
    // Privacy
    profileVisible: { type: "boolean", title: "Public profile" },
    showActivity: { type: "boolean", title: "Show activity status" },
    // Appearance
    theme: {
      type: "string",
      title: "Theme",
      enum: ["light", "dark", "system"],
    },
  },
};

const settingsUiSchema: UISchemaElement = {
  type: "VerticalLayout",
  elements: [
    {
      type: "Group",
      label: "Notifications",
      options: { description: "Choose how you want to be notified." },
      elements: [
        { type: "Control", scope: "#/properties/pushNotifications" },
        { type: "Control", scope: "#/properties/emailNotifications" },
        {
          type: "Control",
          scope: "#/properties/emailFrequency",
          rule: {
            effect: RuleEffect.SHOW,
            condition: {
              scope: "#/properties/emailNotifications",
              schema: { const: true },
            },
          },
        },
        { type: "Control", scope: "#/properties/smsNotifications" },
        {
          type: "Label",
          text: "OK, boomer",
          rule: {
            effect: RuleEffect.SHOW,
            condition: {
              scope: "#/properties/smsNotifications",
              schema: { const: true },
            },
          },
        },
      ],
    },
    {
      type: "Group",
      label: "Privacy",
      options: { description: "Control your visibility and data." },
      elements: [
        { type: "Control", scope: "#/properties/profileVisible", options: { toggle: true } },
        { type: "Control", scope: "#/properties/showActivity", options: { toggle: true } },
      ],
    },
    {
      type: "Group",
      label: "Appearance",
      options: { description: "Customize aesthetics." },
      elements: [{ type: "Control", scope: "#/properties/theme", options: { format: "radio" } }],
    },
  ],
};

// 6. Booking Form (DateTime pickers)
const bookingSchema: JsonSchema = {
  type: "object",
  properties: {
    appointmentDate: { type: "string", format: "date", title: "Date" },
    preferredTime: { type: "string", format: "time", title: "Time" },
    guests: { type: "integer", title: "Guests", minimum: 1, maximum: 3 },
  },
};

const bookingUiSchema: UISchemaElement = {
  type: "VerticalLayout",
  elements: [
    {
      type: "HorizontalLayout",
      elements: [
        { type: "Control", scope: "#/properties/appointmentDate" },
        { type: "Control", scope: "#/properties/preferredTime" },
      ],
    },
    { type: "Control", scope: "#/properties/guests" },
  ],
};

// =============================================================================
// BENTO COMPONENTS
// =============================================================================

interface BentoCardProps {
  title: string;
  description?: string;
  size: "large" | "medium" | "wide" | "tall";
  icon: React.ReactNode;
  animationIndex: number;
  children: React.ReactNode;
  className?: string;
}

const sizeClasses = {
  large: "col-span-1 md:col-span-6 lg:col-span-6",
  medium: "col-span-1 md:col-span-3 lg:col-span-3",
  wide: "col-span-1 md:col-span-9 lg:col-span-9",
  tall: "col-span-1 md:col-span-3 lg:col-span-3 md:row-span-3",
};

function BentoCard({
  title,
  description,
  size,
  icon,
  animationIndex,
  children,
  className,
}: BentoCardProps) {
  return (
    <div
      className={cn(
        // Base card styles
        "relative overflow-hidden rounded-2xl bg-white/90 p-6 shadow-sm ring-1 ring-black/5",
        "dark:bg-slate-950/60 dark:ring-white/10",
        // Animation
        "animate-in fade-in slide-in-from-bottom-4",
        // Grid sizing
        sizeClasses[size],
        className,
      )}
      style={{
        animationDelay: `${animationIndex * 100}ms`,
        animationFillMode: "backwards",
      }}
    >
      {/* Card header */}
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:bg-blue-400/20 dark:text-blue-400">
          {icon}
        </span>
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          {description && <p className="text-fd-muted-foreground text-sm">{description}</p>}
        </div>
      </div>
      {/* Form content */}
      <div className="[&_.jsonforms-group]:border-0 [&_.jsonforms-group]:p-0 [&_.jsonforms-group]:shadow-none">
        {children}
      </div>
    </div>
  );
}

function BentoGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid gap-6",
        // Mobile: single column
        "grid-cols-1",
        // Tablet+Desktop: 12-column grid with dense packing
        "md:grid-flow-dense md:grid-cols-12",
      )}
    >
      {children}
    </div>
  );
}

// =============================================================================
// FORM DEMO COMPONENT
// =============================================================================

export function FormDemo() {
  const [eventData, setEventData] = useState({});
  const [feedbackData, setFeedbackData] = useState({ satisfaction: 5 });
  const [surveyData, setSurveyData] = useState({});
  const [settingsData, setSettingsData] = useState({
    pushNotifications: true,
    profileVisible: true,
  });
  const [bookingData, setBookingData] = useState({ guests: 4, preferredTime: "12:30:00" });

  return (
    <BentoGrid>
      {/* Row 1: Feedback (6 cols) */}
      <BentoCard
        title="Feedback Collection"
        description="Sliders & ratings"
        icon={<MessageSquare className="size-5" />}
        size="large"
        animationIndex={0}
      >
        <ClientSideJsonForms
          schema={feedbackSchema}
          uischema={feedbackUiSchema}
          data={feedbackData}
          onChange={({ data }) => setFeedbackData(data)}
        />
      </BentoCard>

      {/* Row 1: Booking (3 cols) */}
      <BentoCard
        title="Booking"
        description="Date & time pickers"
        icon={<Calendar className="size-5" />}
        size="medium"
        animationIndex={1}
      >
        <ClientSideJsonForms
          schema={bookingSchema}
          uischema={bookingUiSchema}
          data={bookingData}
          onChange={({ data }) => setBookingData(data)}
        />
      </BentoCard>

      {/* Row 1-3: Settings - tall (3 cols, spans 3 rows) */}
      <BentoCard
        title="Settings"
        description="Conditional fields"
        icon={<Settings className="size-5" />}
        size="tall"
        animationIndex={2}
        className="hidden md:block"
      >
        <ClientSideJsonForms
          schema={settingsSchema}
          uischema={settingsUiSchema}
          data={settingsData}
          onChange={({ data }) => setSettingsData(data)}
        />
      </BentoCard>

      {/* Row 2: Event Registration (9 cols) */}
      <BentoCard
        title="Event Registration"
        description="Multi-step forms"
        icon={<ClipboardList className="size-5" />}
        size="wide"
        animationIndex={3}
        className="hidden md:block"
      >
        <ClientSideJsonForms
          schema={eventRegSchema}
          uischema={eventRegUiSchema}
          data={eventData}
          onChange={({ data }) => setEventData(data)}
        />
      </BentoCard>

      {/* Row 3: Survey (9 cols) */}
      <BentoCard
        title="Survey"
        description="Tabbed sections"
        icon={<BarChart3 className="size-5" />}
        size="wide"
        animationIndex={4}
      >
        <ClientSideJsonForms
          schema={surveySchema}
          uischema={surveyUiSchema}
          data={surveyData}
          onChange={({ data }) => setSurveyData(data)}
        />
      </BentoCard>
    </BentoGrid>
  );
}
