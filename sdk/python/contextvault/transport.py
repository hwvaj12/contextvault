"""Bounded binary HTTP transport; mutations never acquire a new key on retry."""
import http.client
import json
import os
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

import requests

from .exceptions import (AuthError, ConflictError, ContextVaultError, ExpiredError, NetworkError,
                         NotFoundError, OutcomeUnknownError, ValidationError)


def server_origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError("base_url must be an HTTP origin")
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("base_url must be an HTTP origin without credentials")
    return value.rstrip("/")


def error_from_body(body, status=0):
    error = body.get("error", {}) if isinstance(body, dict) else {}
    if not isinstance(error, dict):
        error = {"message": str(error)}
    code = error.get("code", "HTTP_ERROR")
    cls = ContextVaultError
    if code == "PUBLICATION_OUTCOME_UNKNOWN":
        cls = OutcomeUnknownError
    elif status in (401, 403):
        cls = AuthError
    elif status == 404:
        cls = NotFoundError
    elif status == 409:
        cls = ConflictError
    elif status == 410:
        cls = ExpiredError
    elif status in (400, 413, 422):
        cls = ValidationError
    return cls(error.get("message", "HTTP " + str(status)), status_code=status, code=code,
               operation_id=error.get("operationId"), retryable=error.get("retryable", False))


class _DeadlineGet:
    """Own one cancellable HTTP GET; no global timers or shared pool connections."""
    def __init__(self, origin, path, headers, timeout, deadline):
        self.origin = urlsplit(origin)
        self.path = path
        self.headers = dict(headers, **{"Accept-Encoding": "identity"})
        self.timeout = timeout
        self.deadline = deadline
        self.done = threading.Event()
        self.cancelled = threading.Event()
        self.guard = threading.Lock()
        self.interrupt_socket = None
        self.value = None
        self.error = None

    def _remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0 or self.cancelled.is_set():
            raise NetworkError("Operation lookup deadline expired")
        return remaining

    def _read(self):
        connection = None
        response = None
        try:
            remaining = self._remaining()
            configured = self.timeout if isinstance(self.timeout, (int, float)) else remaining
            connection_type = http.client.HTTPSConnection if self.origin.scheme == "https" else http.client.HTTPConnection
            options = dict(timeout=min(remaining, configured))
            if self.origin.scheme == "https":
                # Match requests' default CA bundle and hostname verification.
                options["context"] = ssl.create_default_context(cafile=requests.certs.where())
            connection = connection_type(self.origin.hostname, self.origin.port, **options)
            # Connection setup has its own remaining timeout. Cancellation before socket handoff
            # is checked before any HTTP request; the caller never waits past its deadline.
            connection.connect()
            with self.guard:
                self.interrupt_socket = socket.socket(fileno=os.dup(connection.sock.fileno()))
            self._remaining()
            connection.request("GET", self.path, headers=self.headers)
            response = connection.getresponse()
            result = bytearray()
            while True:
                self._remaining()
                chunk = response.read(65536)
                if not chunk:
                    break
                if len(result) + len(chunk) > 32 * 1024 * 1024:
                    raise ValidationError("HTTP JSON response exceeds limit", code="QUOTA_EXCEEDED")
                result.extend(chunk)
            self._remaining()
            try:
                value = json.loads(result.decode("utf-8")) if result else None
            except (ValueError, UnicodeError) as error:
                raise NetworkError("Invalid JSON response") from error
            if not 200 <= response.status < 300:
                raise error_from_body(value, response.status)
            self.value = value
        except ContextVaultError as error:
            self.error = error
        except Exception as error:
            self.error = NetworkError("HTTP operation lookup failed")
            self.error.__cause__ = error
        finally:
            with self.guard:
                if self.interrupt_socket is not None:
                    self.interrupt_socket.close()
                    self.interrupt_socket = None
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
            self.done.set()

    def run(self):
        self._remaining()
        worker = threading.Thread(target=self._read, name="ContextVault-operation-lookup", daemon=True)
        worker.start()
        completed = self.done.wait(max(0, self.deadline - time.monotonic()))
        if not completed or time.monotonic() >= self.deadline:
            self.cancelled.set()
            with self.guard:
                if self.interrupt_socket is not None:
                    try:
                        # A duplicate descriptor interrupts blocked headers/body reads even when
                        # HTTPConnection has handed a close-delimited response its original socket.
                        self.interrupt_socket.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
            raise NetworkError("Operation lookup deadline expired")
        if self.error is not None:
            raise self.error
        return self.value


class Transport:
    def __init__(self, base_url, api_key, timeout=30):
        self.origin = server_origin(base_url)
        self.timeout = timeout
        self.session = requests.Session()
        # Explicit SDK authority must not be replaced by netrc, ambient proxy settings or redirects.
        self.session.trust_env = False
        self.session.headers.update({"X-API-Key": api_key, "Accept": "application/json"})

    def close(self):
        self.session.close()

    def response(self, method, path, key=None, body=None, data=None, headers=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("API paths must be origin-relative")
        if method in ("POST", "PUT", "DELETE") and path.startswith("/v1/") and not key:
            raise ValueError("idempotency_key is required; reuse it with the exact original request on retry")
        outgoing = dict(headers or {})
        if key:
            outgoing["Idempotency-Key"] = key
        try:
            response = self.session.request(method, self.origin + path, json=body, data=data,
                                            headers=outgoing, timeout=self.timeout, stream=True, allow_redirects=False)
        except requests.RequestException as error:
            cls = OutcomeUnknownError if method != "GET" else NetworkError
            raise cls("HTTP request did not produce a known outcome") from error
        if not 200 <= response.status_code < 300:
            try:
                payload = self._json(response)
                failure = error_from_body(payload, response.status_code)
                # Only a complete real HTTP error response can prove a rejection.
                # Local validation and receipt verification errors carry no such evidence.
                failure.http_status = response.status_code
                raise failure
            except NetworkError as error:
                if method != "GET":
                    raise OutcomeUnknownError("Error response was lost before its outcome was known") from error
                raise
            finally:
                response.close()
        return response

    def _json(self, response):
        result = bytearray()
        try:
            for chunk in response.iter_content(65536):
                if len(result) + len(chunk) > 32 * 1024 * 1024:
                    raise ValidationError("HTTP JSON response exceeds limit", code="QUOTA_EXCEEDED")
                result.extend(chunk)
            return json.loads(result.decode("utf-8")) if result else None
        except requests.RequestException as error:
            raise NetworkError("HTTP response stream failed") from error
        except (ValueError, UnicodeError) as error:
            raise NetworkError("Invalid JSON response") from error

    def request(self, method, path, key=None, body=None, data=None, headers=None, *, deadline=None):
        if deadline is not None:
            if method != "GET" or not path.startswith("/") or path.startswith("//"):
                raise ValueError("Deadline transport only accepts origin-relative GET requests")
            outgoing = dict(self.session.headers)
            outgoing.update(headers or {})
            return _DeadlineGet(self.origin, path, outgoing, self.timeout, deadline).run()
        response = self.response(method, path, key, body, data, headers)
        try:
            return self._json(response)
        except (requests.RequestException, NetworkError) as error:
            if method != "GET":
                raise OutcomeUnknownError("Response was lost before its outcome was known") from error
            raise NetworkError("Response stream failed") from error
        finally:
            response.close()
