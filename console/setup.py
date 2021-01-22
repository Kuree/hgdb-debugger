from setuptools import setup
import os
from pathlib import Path


current_directory = os.path.abspath(os.path.dirname(__file__))
with open(os.path.join(current_directory, 'README.rst')) as f:
    long_description = f.read()

setup(
    name='hgdb-debugger',
    version='0.0.1',
    author='Keyi Zhang',
    author_email='keyi@cs.stanford.edu',
    long_description=long_description,
    long_description_content_type='text/x-rst',
    scripts=["hgdb"],
    url="https://github.com/Kuree/hgdb-debugger",
    install_requires=[
        "prompt_toolkit",
        "hgdb[client]",
        "pygments"
    ],
    python_requires=">=3.6"
)
