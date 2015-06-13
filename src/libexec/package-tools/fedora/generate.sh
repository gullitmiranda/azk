#! /bin/bash

if [[ $# < 2 ]] || [[ $# > 3 ]]; then
    echo "Usage: ${0##*/} {distro} {secret_key} [--clean-repo]"
    exit 1
fi

if [[ $# == 3 ]] && [[ "$3" == "--clean_repo" ]]; then
  CLEAN_REPO=true
fi

if [[ ! -e Azkfile.js ]]; then
    echo "Run this script in the project root"
    exit 2
fi

set -x
set -e

export PATH=`pwd`/bin:$PATH
export DISTRO=$1
export SECRET_KEY=$2

gpg --import $SECRET_KEY

[[ $CLEAN_REPO == true ]] && rm -Rf package/${DISTRO}
mkdir -p package/${DISTRO}/packages
cp -Rf package/rpm/* package/${DISTRO}/packages

echo "%_signature gpg" > ~/.rpmmacros
echo "%_gpg_name everton@azukiapp.com" >> ~/.rpmmacros

(cd package/${DISTRO}/packages && rpm --resign *.rpm)

createrepo package/${DISTRO}
