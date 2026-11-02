import { PresenceStack, type PresencePerson } from "./presence-stack";

export default { title: "Feedback/Presence stack" };

function person(id: string, initials: string, name: string, activity: string): PresencePerson {
  return { id, initials, name, email: `${id}@acme.test`, activity };
}

const people: PresencePerson[] = [
  person("ada", "AL", "Ada Lovelace", "Dashboard · now"),
  person("grace", "GH", "Grace Hopper", "Files · 2m ago"),
  person("alan", "AT", "Alan Turing", "Elsewhere · 4m ago"),
  person("katherine", "KJ", "Katherine Johnson", "Agents · now"),
  person("edsger", "ED", "Edsger Dijkstra", "Computers · 1m ago"),
];

export function One() {
  return <PresenceStack people={people.slice(0, 1)} />;
}

export function Few() {
  return <PresenceStack people={people.slice(0, 3)} />;
}

export function Overflowing() {
  return <PresenceStack people={people} />;
}
