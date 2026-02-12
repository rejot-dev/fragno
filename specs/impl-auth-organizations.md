# Auth Organizations and Roles - Implementation Plan

Specs: [spec-auth-organizations.md](./spec-auth-organizations.md)

- [ ] (FRAGNO-xnalurze) Extend auth schema with organization tables, member role assignments, and
      session.activeOrganizationId (specs/spec-auth-organizations.md §7).
- [ ] (FRAGNO-mhgfdadu) Implement organization services, including auto-create on user creation and
      role assignment lifecycle (specs/spec-auth-organizations.md §6.3, §8.2).
- [ ] (FRAGNO-fiowuyjm) Wire auth hooks (user/session) and organization hooks via provideHooks
      (specs/spec-auth-organizations.md §6.4).
- [ ] (FRAGNO-mlgdexfb) Add conservative organization routes and extend `/me` bootstrap payload
      (specs/spec-auth-organizations.md §9).
- [ ] (FRAGNO-lsjilkyb) Extend client hooks and exported types for multi-role orgs and `/me`
      (specs/spec-auth-organizations.md §6.2, §6.5).
- [ ] (FRAGNO-ziidghjy) Enforce authorization rules, last-owner checks, and config limits
      (specs/spec-auth-organizations.md §10-11).
- [ ] (FRAGNO-mdktinbj) Add tests for organization services/routes/hooks, auto-create flows, and
      `/me` payloads (specs/spec-auth-organizations.md §16).
- [ ] (FRAGNO-sbkhleol) Document organization setup, invitation flows, and `/me` bootstrap response
      (specs/spec-auth-organizations.md §15).
