# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
