# @fragno-dev/cli

## 0.2.0

### Minor Changes

- 8e9b6cd: feat(db,cli): add SqlAdapter and explicit schema output formats

  BREAKING CHANGE: The database adapter API now requires SqlAdapter with explicit schema output
  formats.

### Patch Changes

- 15e3263: feat(db): require schema names and support namespace-aware SQL naming
- Updated dependencies [f569301]
- Updated dependencies [dbbbf60]
- Updated dependencies [3e07799]
- Updated dependencies [20a98f8]
- Updated dependencies [1902f30]
- Updated dependencies [15e3263]
- Updated dependencies [208cb8e]
- Updated dependencies [33f671b]
- Updated dependencies [fc803fc]
- Updated dependencies [0628c1f]
- Updated dependencies [7e1eb47]
- Updated dependencies [301e2f8]
- Updated dependencies [5f6f90e]
- Updated dependencies [1dc4e7f]
- Updated dependencies [2eafef4]
- Updated dependencies [3c9fbac]
- Updated dependencies [a5ead11]
- Updated dependencies [7d7b2b9]
- Updated dependencies [c4d4cc6]
- Updated dependencies [d4baad3]
- Updated dependencies [548bf37]
- Updated dependencies [a79e90d]
- Updated dependencies [3041732]
- Updated dependencies [7e179d1]
- Updated dependencies [0013fa6]
- Updated dependencies [7c60341]
- Updated dependencies [afb06a4]
- Updated dependencies [53e5f97]
- Updated dependencies [8e9b6cd]
- Updated dependencies [c5fd7b3]
- Updated dependencies [69b9a79]
- Updated dependencies [5cef16e]
  - @fragno-dev/core@0.2.0
  - @fragno-dev/db@0.3.0
  - @fragno-dev/corpus@0.0.7

## 0.1.23

### Patch Changes

- Updated dependencies [aca5990]
- Updated dependencies [f150db9]
- Updated dependencies [0b373fc]
- Updated dependencies [fe27e33]
- Updated dependencies [9753f15]
  - @fragno-dev/db@0.2.2
  - @fragno-dev/corpus@0.0.7

## 0.1.22

### Patch Changes

- Updated dependencies [aecfa70]
- Updated dependencies [3faac77]
- Updated dependencies [01a9c6d]
- Updated dependencies [5028ad3]
- Updated dependencies [20d824a]
  - @fragno-dev/db@0.2.1
  - @fragno-dev/corpus@0.0.7

## 0.1.21

### Patch Changes

- ca0db15: fix: resolve TSConfig paths when loading Fragment files
- fcce048: feat: use "dry run" mode when searching for database schemas to be more lenient when
  instantiating a Fragment
- f9ae2d3: fix: database namespace generation
- Updated dependencies [8429960]
- Updated dependencies [4d897c9]
- Updated dependencies [a46b59c]
- Updated dependencies [bc072dd]
- Updated dependencies [e46d2a7]
- Updated dependencies [fcce048]
- Updated dependencies [147bdd6]
- Updated dependencies [f9ae2d3]
- Updated dependencies [f3b7084]
- Updated dependencies [c3870ec]
- Updated dependencies [75e298f]
  - @fragno-dev/db@0.2.0
  - @fragno-dev/core@0.1.11
  - @fragno-dev/corpus@0.0.7

## 0.1.20

### Patch Changes

- Updated dependencies [aabd6d2]
  - @fragno-dev/core@0.1.10
  - @fragno-dev/corpus@0.0.6
  - @fragno-dev/db@0.1.15

## 0.1.19

### Patch Changes

- 5ea24d2: refactor: improve Fragment builder and instatiator
- Updated dependencies [d6a7ff5]
- Updated dependencies [e848208]
- Updated dependencies [e9b2e7d]
- Updated dependencies [5e185bc]
- Updated dependencies [ec622bc]
- Updated dependencies [219ce35]
- Updated dependencies [b34917f]
- Updated dependencies [7276378]
- Updated dependencies [462004f]
- Updated dependencies [5ea24d2]
- Updated dependencies [f22c503]
- Updated dependencies [3474006]
  - @fragno-dev/db@0.1.15
  - @fragno-dev/core@0.1.9
  - @fragno-dev/corpus@0.0.6

## 0.1.18

### Patch Changes

- efb6428: Fix corpus command failing when run outside monorepo due to missing subjects directory in
  published package
- be14041: feat: allow arbitrary nesting in corpus tree
- 4eaedb3: feat: reorganize corpus subject tree
- Updated dependencies [2e4be36]
- Updated dependencies [efb6428]
- Updated dependencies [be14041]
- Updated dependencies [4eaedb3]
  - @fragno-dev/corpus@0.0.5

## 0.1.17

### Patch Changes

- Updated dependencies [acb0877]
- Updated dependencies [acb0877]
  - @fragno-dev/corpus@0.0.4
  - @fragno-dev/core@0.1.8
  - @fragno-dev/db@0.1.14

## 0.1.16

### Patch Changes

- Updated dependencies [09a1e13]
  - @fragno-dev/core@0.1.7
  - @fragno-dev/corpus@0.0.3
  - @fragno-dev/db@0.1.13

## 0.1.15

### Patch Changes

- c3d52b8: feat: add `--start`, `--end`, `--headings`, and `--id` flags to corpus command
- c74bf81: fix: `corpus` command now shows full examples
- a2c6228: feat: properly render Markdown output in terminal (syntax highlighting etc)
- Updated dependencies [be537b1]
- Updated dependencies [b54ff8b]
- Updated dependencies [c3d52b8]
- Updated dependencies [c74bf81]
  - @fragno-dev/corpus@0.0.3
  - @fragno-dev/db@0.1.13

## 0.1.14

### Patch Changes

- 4ec7e78: feat: add search command for documentation lookup

  Add a new `search` command to fragno-cli that searches the Fragno documentation directly from the
  command line. Results are automatically grouped by page URL with all relevant sections displayed
  together.

- 4ec7e78: feat: add corpus command to view code examples and documentation

  The new `corpus` command allows users and LLMs to access tested, type-checked code examples
  organized by subject. Examples include route definition, database querying, and adapter setup. Use
  `fragno-cli corpus [topic...]` to view one or more topics.

- 27cc540: fix: Corpus dependency issue
- Updated dependencies [be1a630]
- Updated dependencies [b2a88aa]
- Updated dependencies [2900bfa]
- Updated dependencies [27cc540]
- Updated dependencies [059a249]
- Updated dependencies [f3f7bc2]
- Updated dependencies [a9f8159]
- Updated dependencies [9d4cd3a]
- Updated dependencies [fdb5aaf]
  - @fragno-dev/core@0.1.6
  - @fragno-dev/db@0.1.12
  - @fragno-dev/corpus@0.0.2

## 0.1.13

### Patch Changes

- Updated dependencies [b6dd67a]
- Updated dependencies [ec1aed0]
- Updated dependencies [9a58d8c]
  - @fragno-dev/core@0.1.5
  - @fragno-dev/db@0.1.11

## 0.1.12

### Patch Changes

- Updated dependencies [ca57fac]
  - @fragno-dev/core@0.1.4
  - @fragno-dev/db@0.1.10

## 0.1.11

### Patch Changes

- Updated dependencies [ad3e63b]
  - @fragno-dev/db@0.1.10

## 0.1.10

### Patch Changes

- Updated dependencies [8fcceb6]
  - @fragno-dev/db@0.1.9

## 0.1.9

### Patch Changes

- Updated dependencies [f3cdb1d]
  - @fragno-dev/db@0.1.8

## 0.1.8

### Patch Changes

- ab6c4bf: fix: make Fragment loading in the CLI more robust
- Updated dependencies [e36dbcd]
- Updated dependencies [ab6c4bf]
- Updated dependencies [d1feecd]
  - @fragno-dev/db@0.1.7

## 0.1.7

### Patch Changes

- d330bb9: fix: change `bin` to `fragno-cli`
- Updated dependencies [70bdcb2]
  - @fragno-dev/db@0.1.6

## 0.1.6

### Patch Changes

- Updated dependencies [8b2859c]
- Updated dependencies [bef9f6c]
- Updated dependencies [711226d]
  - @fragno-dev/db@0.1.5
  - @fragno-dev/core@0.1.3

## 0.1.5

### Patch Changes

- Updated dependencies [5d56f48]
- Updated dependencies [fd3ddd2]
  - @fragno-dev/db@0.1.4

## 0.1.4

### Patch Changes

- Updated dependencies [0723f84]
  - @fragno-dev/db@0.1.3

## 0.1.3

### Patch Changes

- a8b1f81: `db generate` command now supports targeting multiple Fragment files
- a8b1f81: `db info` command now supports targeting multiple files
- be17727: Added support for generating migrations in multi-Fragment applications
- Updated dependencies [e7122f2]
- Updated dependencies [921ef11]
- Updated dependencies [be17727]
- Updated dependencies [8362d9a]
- Updated dependencies [8362d9a]
- Updated dependencies [c70de59]
  - @fragno-dev/db@0.1.2
  - @fragno-dev/core@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies [4c1c806]
  - @fragno-dev/db@0.1.1
  - @fragno-dev/core@0.1.1

## 0.1.1

### Patch Changes

- Updated dependencies [74a615c]
  - @fragno-dev/core@0.1.0
  - @fragno-dev/db@0.1.0

## 0.1.0

### Minor Changes

- 2c583a9: Initial release of @fragno-dev/db

### Patch Changes

- Updated dependencies [2c583a9]
  - @fragno-dev/db@0.1.0

## 0.0.2

### Patch Changes

- Updated dependencies [1fa71f3]
- Updated dependencies [c1483c6]
  - @fragno-dev/core@0.0.7
