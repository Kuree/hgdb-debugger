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

Road map:
- Currently it sets the hgdb runtime to single-thread mode to avoid showing multiple instances. This will be resolved once there is a cleaner way to show multiple instances
- Limited high-level data type reconstruction. Again, will be added once there is a better way to render such stuff in the console.

Here is a rendered `asciinema`:


![SVG of hgdb-console](https://rawcdn.githack.com/Kuree/files/29a6a3c427b46755be29cb513388112490c89ba5/images/hgdb-console.svg)