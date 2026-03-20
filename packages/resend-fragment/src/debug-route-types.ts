import { registerDomainRoutes } from "./routes";
import { resendRoutesFactory } from "./routes";

type DomainRoutes = ReturnType<typeof registerDomainRoutes>;
type DomainPath = DomainRoutes[number]["path"];

type HasDomainLiteral = "/domains" extends DomainPath ? true : false;
type HasDomainIdLiteral = "/domains/:domainId" extends DomainPath ? true : false;
type HasOtherLiteral = "/other" extends DomainPath ? true : false;

const _assertA: HasDomainLiteral = true;
const _assertB: HasDomainIdLiteral = true;
// @ts-expect-error: domain routes should reject unrelated paths
const _assertC: HasOtherLiteral = true;

type AllPaths = ReturnType<typeof resendRoutesFactory>[number]["path"];
type HasEmails = "/emails" extends AllPaths ? true : false;
type HasEmailId = "/emails/:emailId" extends AllPaths ? true : false;
type HasThread = "/threads/:threadId" extends AllPaths ? true : false;
type HasOtherPath = "/not-a-route" extends AllPaths ? true : false;

const _assertD: HasEmails = true;
const _assertE: HasEmailId = true;
const _assertF: HasThread = true;
// @ts-expect-error: combined routes should reject unrelated paths
const _assertG: HasOtherPath = true;

const _domainPath: DomainPath = "/domains";
const _allPath: AllPaths = "/emails";

// These should fail when the path unions stay narrow.
// @ts-expect-error: domain path union should not accept arbitrary strings
const _failDomain: DomainPath = "/other";
// @ts-expect-error: route path union should not accept arbitrary strings
const _failAll: AllPaths = "/not-a-route";
