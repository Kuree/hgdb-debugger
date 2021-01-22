import os
import subprocess
import tempfile
import time
import socket
from hgdb import DebugSymbolTable
from contextlib import closing


def start_server(port_num, program_name, args=None, wait=0):
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    # find build folder
    dirs = [os.path.join(root, d) for d in os.listdir(root) if os.path.isdir(d) and "build" in d]
    assert len(dirs) > 0, "Unable to detect build folder"
    # use the shortest one
    dirs.sort(key=lambda x: len(x))
    build_dir = dirs[0]
    server_path = os.path.join(build_dir, "tests", program_name)
    if args is None:
        args = []
    args.append("+DEBUG_PORT=" + str(port_num))
    args = [server_path, "+DEBUG_LOG"] + args
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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


if __name__ == "__main__":
    test_repl()