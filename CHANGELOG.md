# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.8] - 2022-11-14
### Added
- Allow special values such as breakpoint id and namespace id printout in console repl mode

### Changed
- Update hgdb backend API changes

## [0.0.7] - 2022-06-06
### Added
- Add source mapping support in the console
- Allow DAP port to be configured ahead of time (#9)
- Allow debugging C/C++ host languages

### Changed
- Make the vscode extension workspace only

### Fixed
- Fix nest array hierarchy in code code that results in duplicated entries

## [0.0.6] - 2022-03-08
### Added
- Add data breakpoint in both vscode and console
- Add support for complex data types

### Fixed
- Fix a bug in multiple column debug files

## [0.0.5] - 2021-10-06
### Fixed
- Switch to webpack for proper vscode packaging

## [0.0.4] - 2021-10-05
### Added
- Add workspace to console for basedname-based search
- Persistent file-based history for console
- Add jump command to console
- Add instance/thread select to sonsole

### Changed
- Console command implementation is now using argparse
- Console args is changed to be consistent with gdb

### Fixed
- Fix a bug in vscode where the basename is used for search

## [0.0.3] - 2021-02-18
### Added
- Add language support for scala
- Add set value
- Add reverse continue

### Changed
- eval scope changes
- Code changes to response command ACK

### Fixed
- Fix eval API change from remote

## [0.0.2] - 2021-02-03
### Added
- Add data type reconstruction for the console version
- Add step over support
- Add step back
- Allow port to be specified in the vscode debug dialog

### Changed
- Update REPL logic due to remote change

## [0.0.1] - 2021-01-21
Initial release. vscode version is a refactor of the old kratos-vscode. The runtime is
rewritten from scratch with websocket and proper async logic.
### Added
- Websocket + JSON based communication
- vscode extension
- gdb-style console debugger
