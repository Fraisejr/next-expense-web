import Foundation
import Security

struct MobileAPIError: LocalizedError {
    let message: String
    let status: Int
    var errorDescription: String? { message }
}

/// Only public endpoints belong in the app. Database and bank credentials stay on the server.
struct NeonConfiguration {
    let authURL: URL
    let dataURL: URL
    static let production = NeonConfiguration(
        authURL: URL(string: "https://ep-quiet-breeze-b2f9puu2.neonauth.c-6.eu-central-1.aws.neon.tech/neondb/auth")!,
        dataURL: URL(string: "https://ep-quiet-breeze-b2f9puu2.apirest.c-6.eu-central-1.aws.neon.tech/neondb/rest/v1")!
    )
}

protocol SessionVault {
    func read() throws -> Data?
    func write(_ data: Data?) throws
}

struct KeychainSessionVault: SessionVault {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.fraisejr.NextExpense.neon-session",
         kSecAttrAccount as String: NeonConfiguration.production.authURL.absoluteString]
    }
    func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw MobileAPIError(message: "Could not unlock the saved session.", status: Int(status)) }
        return result as? Data
    }
    func write(_ data: Data?) throws {
        let deleted = SecItemDelete(query as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            throw MobileAPIError(message: "Could not clear the saved session.", status: Int(deleted))
        }
        guard let data else { return }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary, nil)
        guard status == errSecSuccess else { throw MobileAPIError(message: "Could not save the session securely.", status: Int(status)) }
    }
}

@MainActor
final class NeonAPI {
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private struct SavedCookie: Codable {
        let name: String
        let value: String
        let expires: Date?
    }
    private let configuration: NeonConfiguration
    private let session: URLSession
    private let vault: SessionVault
    private var cookies: [SavedCookie] = []
    private var jwt: String?

    init(configuration: NeonConfiguration = .production, session: URLSession? = nil, vault: SessionVault = KeychainSessionVault()) {
        self.configuration = configuration
        self.vault = vault
        let options = URLSessionConfiguration.ephemeral
        options.httpShouldSetCookies = false
        options.urlCache = nil
        self.session = session ?? URLSession(configuration: options, delegate: NoRedirects(), delegateQueue: nil)
    }

    func restore() throws -> Bool {
        if let data = try vault.read() { cookies = try JSONDecoder().decode([SavedCookie].self, from: data) }
        cookies.removeAll { ($0.expires ?? .distantFuture) <= Date() }
        return !cookies.isEmpty
    }

    func signIn(email: String, password: String) async throws {
        try clearSession()
        _ = try await auth("sign-in/email", method: "POST", body: ["email": email, "password": password])
        try await refreshToken()
    }

    func clearSession() throws {
        cookies = []
        jwt = nil
        try vault.write(nil)
    }

    func signOut() async throws {
        var failure: Error?
        do { _ = try await auth("sign-out", method: "POST", body: [:]) } catch { failure = error }
        try clearSession()
        if let failure { throw failure }
    }

    func refreshToken() async throws {
        let (data, response) = try await auth("get-session")
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["session"] is [String: Any] else {
            try clearSession()
            throw MobileAPIError(message: "Your session expired. Sign in again.", status: 401)
        }
        // Neon exposes the Data API JWT in this header; the session cookie is not a JWT.
        if let token = response.value(forHTTPHeaderField: "set-auth-jwt"), !token.isEmpty { jwt = token; return }
        let (tokenData, _) = try await auth("token")
        struct Token: Decodable { let token: String }
        jwt = try JSONDecoder().decode(Token.self, from: tokenData).token
    }

    func data<T: Decodable>(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        if jwt == nil { try await refreshToken() }
        do { return try await dataRequest(path, query: query, method: method, body: body) }
        catch let error as MobileAPIError where error.status == 401 {
            // One renewal only; never retry a mutation on a transport failure.
            try await refreshToken()
            return try await dataRequest(path, query: query, method: method, body: body)
        }
    }

    private func dataRequest<T: Decodable>(_ path: String, query: [URLQueryItem], method: String, body: [String: Any]?) async throws -> T {
        var components = URLComponents(url: configuration.dataURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("Bearer \(jwt ?? "")", forHTTPHeaderField: "Authorization")
        request.setValue("return=representation", forHTTPHeaderField: "Prefer")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await send(request)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }

    private func auth(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: configuration.authURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("https://\(configuration.authURL.host!)", forHTTPHeaderField: "Origin")
        let valid = cookies.filter { ($0.expires ?? .distantFuture) > Date() }
        if !valid.isEmpty { request.setValue(valid.map { "\($0.name)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await send(request)
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            if let key = item.key as? String, let value = item.value as? String { result[key] = value }
        }
        for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: request.url!) {
            cookies.removeAll { $0.name == cookie.name }
            if (cookie.expiresDate ?? .distantFuture) > Date() {
                cookies.append(SavedCookie(name: cookie.name, value: cookie.value, expires: cookie.expiresDate))
            }
        }
        try vault.write(try JSONEncoder().encode(cookies))
        return (data, response)
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard request.url?.scheme == "https" else { throw MobileAPIError(message: "A secure connection is required.", status: 0) }
        var request = request
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw MobileAPIError(message: object?["message"] as? String ?? "The server could not complete the request (\(response.statusCode)).", status: response.statusCode)
        }
        return (data, response)
    }
}
