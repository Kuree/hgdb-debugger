# HGDB Debuggers
A collections of hgdb debuggers

## Visual Studio Code
This debugger is the reference implementation of an IDE-based debugger.
To install, simply use the following command in the VS code console:

```
ext install keyiz.hgdb-vscode
```

Users should expect the same debugging experience as debugging any program in Visual Studio Code as it implements the majority of the adapter protocol.

Supported Features:
- Set/remove breakpoints
- REPL
- Multiple instances view
- Complex data type rendering

Road map:
- Variable watch. Variables that have RTL correspondence should be able to added to the watch panel to help debugging.

To use the debugger, simply press <key>F5</key> and choose `HGDB debug`.

Below is a quick overview of its interface

![Gif of hgdb-vscode](https://rawcdn.githack.com/Kuree/kratos-vscode/d0dc4e40b186297da9a419298459f4dbc2a13224/images/demo.gif)

## Console
The console version is implemented in Python and mimics the style of `gdb`. It uses built-in Python-bindings to communicate with the `hgdb` runtime.
To install this debugger, simply do

```
$ pip install hgdb-debugger
```

Below is an example usage

```
$ hgdb -i debug.db
```

Supported Features:
- Set/remove breakpoints
- REPL!
- Auto complete and suggestion
- Pretty print on complex data type

Road map:
- Currently it sets the hgdb runtime to single-thread mode to avoid showing multiple instances. This will be resolved once there is a cleaner way to show multiple instances

Here is a rendered `asciinema` of the hgdb console debugger when debugging simulation with Xcelium:


![SVG of hgdb-console](https://rawcdn.githack.com/Kuree/files/29a6a3c427b46755be29cb513388112490c89ba5/images/hgdb-console.svg)