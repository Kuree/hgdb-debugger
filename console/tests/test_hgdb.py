import os
import subprocess
import tempfile
import time
import socket
from hgdb import DebugSymbolTable
from contextlib import closing
import sys


def start_server(port_num, program_name, args=None, wait=0, log=False, supports_rewind=False):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    # find build folder
    dirs = [os.path.join(root, d) for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)) and "build" in d]
    assert len(dirs) > 0, "Unable to detect build folder"
    # use the shortest one
    dirs.sort(key=lambda x: len(x))
    build_dir = dirs[0]
    server_path = os.path.join(build_dir, "tests", program_name)
    if args is None:
        args = []
    args.append("+DEBUG_PORT=" + str(port_num))
    if supports_rewind:
        args.append("+REWIND")
    args = [server_path, "+DEBUG_LOG"] + args
    p = subprocess.Popen(args, stdout=subprocess.PIPE if not log else sys.stdout,
                         stderr=subprocess.PIPE if not log else sys.stdout)
    time.sleep(wait)
    return p


def find_free_port():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(('', 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


def start_program(port, **kwargs):
    dirname = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    hgdb = os.path.join(dirname, "hgdb")
    # use a fake db for arguments
    args = [hgdb, ":" + str(port),  "no-db", "--no-db-connection"]
    extra_args = []
    for n, v in kwargs.items():
        extra_args.append("--" + n)
        extra_args.append(v)
    args = args + extra_args
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    return p


def test_set_breakpoint_continue():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server")
    # run the debugger
    p = start_program(port)
    # continue
    out = p.communicate(input=b"b test.py:1\nc\n")[0]
    out = out.decode("ascii")
    assert "Breakpoint 2 at test.py:1" in out
    s.kill()
    p.kill()


def test_rewind_time():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server", supports_rewind=True)
    # run the debugger
    p = start_program(port)
    # continue
    out = p.communicate(input=b"b test.py:1\nc\ngo 200\ninfo time\n")[0]
    out = out.decode("ascii")
    assert "201" in out
    s.kill()
    p.kill()


def test_repl():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server")
    # run the debugger
    p = start_program(port)
    # continue
    out = p.communicate(input=b"p 41 + mod.a\n")[0]
    out = out.decode("ascii")
    assert "42" in out
    s.kill()
    p.kill()


def test_step_over():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server")
    # run the debugger
    p = start_program(port)
    # continue
    out = p.communicate(input=b"n\nn\nn\n")[0]
    out = out.decode("ascii")
    assert "Breakpoint 2 at test.py:1" in out
    assert "Breakpoint 9 at test.py:1" in out
    assert "Breakpoint 0 at test.py:2" in out
    s.kill()
    p.kill()


def test_set_value():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server")
    p = start_program(port)
    # continue
    out = p.communicate(input=b"n\nset a=100\np a\nn\nn\np a + 1\n")[0]
    out = out.decode("ascii")
    assert "100" in out
    assert "101" in out
    s.kill()
    p.kill()


def test_data_breakpoint():
    port = find_free_port()
    s = start_server(port, "test_debug_server")
    p = start_program(port)
    # continue
    out = p.communicate(input=b"w c\nc\nc\ninfo watchpoint\n")[0]
    out = out.decode("ascii")
    assert "Watchpoint 0 at test.py:2" in out
    assert "Watchpoint 3 at test.py:5" in out
    assert "3\ttest.py:5\tc" in out
    s.kill()
    p.kill()


def test_src_mapping():
    port = find_free_port()
    # start the server
    s = start_server(port, "test_debug_server")
    # run the debugger
    p = start_program(port, map=":/tmp")
    # continue
    out = p.communicate(input=b"b /tmp/test.py:1\nc\n")[0]
    out = out.decode("ascii")
    assert "Breakpoint 2 at test.py:1" in out
    s.kill()
    p.kill()


if __name__ == "__main__":
    test_src_mapping()
