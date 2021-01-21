from setuptools import setup
import os
from pathlib import Path


long_description = ""


setup(
    name='hgdb-debugger',
    version='0.0.1',
    author='Keyi Zhang',
    author_email='keyi@cs.stanford.edu',
    long_description=long_description,
    long_description_content_type='text/x-rst',
    scripts=["debugger"],
    url="https://github.com/Kuree/hgdb-debugger",
    install_requires=[
        "rich",
        "hgdb[client]"
    ],
    python_requires=">=3.6"
)
