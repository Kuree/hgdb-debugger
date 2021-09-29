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


def start_program(filename, port):
    dirname = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    hgdb = os.path.join(dirname, "hgdb")
    args = [hgdb, "-i", filename, "-p", str(port), "--no-db-connection"]
    p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    return p


def create_db(filename):
    # only need to fill in the breakpoints for file names
    table = DebugSymbolTable(filename)
    table.store_instance(1, "mod")
    table.store_breakpoint(0, 1, "/tmp/test.py", 1)
    table.store_variable(0, "a")
    table.store_context_variable("a", 0, 0)


def test_set_breakpoint_continue():
    port = find_free_port()
    with tempfile.TemporaryDirectory() as temp:
        db_filename = os.path.join(temp, "debug.db")
        create_db(db_filename)
        # start the server
        s = start_server(port, "test_debug_server")
        # run the debugger
        p = start_program(db_filename, port)
        # continue
        out = p.communicate(input=b"b test.py:1\nc\n")[0]
        out = out.decode("ascii")
        assert "Breakpoint 2 at test.py:1" in out
        s.kill()
        p.kill()


def test_rewind_time():
    port = find_free_port()
    with tempfile.TemporaryDirectory() as temp:
        db_filename = os.path.join(temp, "debug.db")
        create_db(db_filename)
        # start the server
        s = start_server(port, "test_debug_server", supports_rewind=True)
        # run the debugger
        p = start_program(db_filename, port)
        # continue
        out = p.communicate(input=b"b test.py:1\nc\ngo 200\ninfo time\n")[0]
        out = out.decode("ascii")
        assert "201" in out
        s.kill()
        p.kill()


def test_repl():
    port = find_free_port()
    with tempfile.TemporaryDirectory() as temp:
        db_filename = os.path.join(temp, "debug.db")
        create_db(db_filename)
        # start the server
        s = start_server(port, "test_debug_server")
        # run the debugger
        p = start_program(db_filename, port)
        # continue
        out = p.communicate(input=b"p 41 + mod.a\n")[0]
        out = out.decode("ascii")
        assert "42" in out
        s.kill()
        p.kill()


def test_step_over():
    port = find_free_port()
    with tempfile.TemporaryDirectory() as temp:
        db_filename = os.path.join(temp, "debug.db")
        create_db(db_filename)
        # start the server
        s = start_server(port, "test_debug_server")
        # run the debugger
        p = start_program(db_filename, port)
        # continue
        out = p.communicate(input=b"s\ns\ns\n")[0]
        out = out.decode("ascii")
        assert "Breakpoint 2 at test.py:1" in out
        assert "Breakpoint 7 at test.py:1" in out
        assert "Breakpoint 0 at test.py:2" in out
        s.kill()
        p.kill()


def test_set_value():
    port = find_free_port()
    with tempfile.TemporaryDirectory() as temp:
        db_filename = os.path.join(temp, "debug.db")
        create_db(db_filename)
        # start the server
        s = start_server(port, "test_debug_server")
        p = start_program(db_filename, port)
        # continue
        out = p.communicate(input=b"s\nset a = 100\np a\ns\ns\np a + 1\n")[0]
        out = out.decode("ascii")
        assert "100" in out
        assert "101" in out
        s.kill()
        p.kill()


if __name__ == "__main__":
    test_rewind_time()
