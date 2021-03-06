#!/bin/bash
#
# Utility functions for build/test scripts.

function error() {
    >&2 echo $1
    >&2 echo "usage: $0 [--version <major-version>] [--arch (cpu*|gpu)] [--region <aws-region>]"
    exit 1
}

function get_latest_major_version() {
    ls -1 docker/ | sort -r -n -t.  -k 1,1 -k 2,2 -k 3 | head -1
}

function get_minor_version() {
    grep 'tensorflow/serving:' docker/$1/Dockerfile.cpu | sed 's#^.*:\([0-9][0-9\.]*\) .*#\1#'
}

function get_default_region() {
    aws configure get region
}

function get_aws_account() {
    aws sts get-caller-identity --query 'Account' --output text
}

function parse_std_args() {
    # defaults
    arch='cpu'
    major_version=$(get_latest_major_version)
    aws_region=$(get_default_region)

    while [[ $# -gt 0 ]]; do
    key="$1"

    case $key in
        -v|--version)
        major_version="$2"
        shift
        shift
        ;;
        -a|--arch)
        arch="$2"
        shift
        shift
        ;;
        -r|--region)
        aws_region="$2"
        shift
        shift
        ;;
        *) # unknown option
        error "unknown option: $1"
        shift
        ;;
    esac
    done

    [[ -z "${major_version// }" ]] && error 'missing version'
    [[ "$arch" =~ ^(cpu|gpu)$ ]] || error "invalid arch: $arch"
    [[ -z "${aws_region// }" ]] && error 'missing aws region'

    minor_version=$(get_minor_version $major_version)

    true
}


