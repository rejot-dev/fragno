import {
  LooppBusinessCardBack,
  LooppBusinessCardFront,
  type LooppBusinessCardPerson,
} from "./loopp-business-card";

export default { title: "Brand/Business card" };

const PEOPLE: readonly LooppBusinessCardPerson[] = [
  {
    name: "Sam Jansen",
    role: "Founder",
    email: "sam@rejot.dev",
    phone: "+31 6 1234 5678",
    website: "rejot.dev",
  },
  {
    name: "Noor van den Berg",
    role: "Solutions engineer",
    email: "noor@rejot.dev",
    phone: "+31 6 8765 4321",
    website: "rejot.dev",
  },
];

// Every line on the back is a text control, so a card can be set for anyone before printing it.
export const FrontAndBack = {
  args: PEOPLE[0],
  render: (person: LooppBusinessCardPerson) => (
    <div className="flex flex-wrap gap-8">
      <LooppBusinessCardFront />
      <LooppBusinessCardBack person={person} />
    </div>
  ),
};

// Long names and roles are where a card's back runs out of room first.
export function Team() {
  return (
    <div className="flex flex-wrap gap-8">
      {PEOPLE.map((person) => (
        <LooppBusinessCardBack key={person.name} person={person} />
      ))}
    </div>
  );
}
