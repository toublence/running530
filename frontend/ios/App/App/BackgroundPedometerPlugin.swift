import Foundation
import Capacitor
import CoreMotion

@objc(BackgroundPedometerPlugin)
public class BackgroundPedometerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundPedometerPlugin"
    public let jsName = "BackgroundPedometer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startUpdates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopUpdates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryHistoricalData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getServiceStatus", returnType: CAPPluginReturnPromise)
    ]

    private let pedometer = CMPedometer()
    private var lastStopTime: Date?
    private let userDefaults = UserDefaults.standard
    private let lastStopTimeKey = "BackgroundPedometer_lastStopTime"
    private let sessionRunningKey = "BackgroundPedometer_sessionRunning"
    private let sessionStartTimeKey = "BackgroundPedometer_sessionStartTime"
    private let totalSessionStepsKey = "BackgroundPedometer_totalSessionSteps"

    @objc func isAvailable(_ call: CAPPluginCall) {
        let available = CMPedometer.isStepCountingAvailable()
        call.resolve([
            "available": available
        ])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        // iOS에서는 CMPedometer 사용 시 자동으로 권한 요청
        // Motion & Fitness 권한은 Info.plist의 NSMotionUsageDescription으로 처리
        if CMPedometer.authorizationStatus() == .authorized {
            call.resolve(["status": "granted"])
        } else if CMPedometer.authorizationStatus() == .denied {
            call.resolve(["status": "denied"])
        } else if CMPedometer.authorizationStatus() == .restricted {
            call.resolve(["status": "restricted"])
        } else {
            // notDetermined - 첫 사용 시 자동으로 권한 요청됨
            call.resolve(["status": "notDetermined"])
        }
    }

    @objc func startUpdates(_ call: CAPPluginCall) {
        guard CMPedometer.isStepCountingAvailable() else {
            call.reject("Step counting not available")
            return
        }

        // 세션이 이미 실행 중인지 확인
        let wasRunning = userDefaults.bool(forKey: sessionRunningKey)
        let existingSessionStart = userDefaults.double(forKey: sessionStartTimeKey)

        let sessionStartTime: Double
        var baselineSteps: Int = 0  // 세션 시작 이전의 걸음수 (히스토리 또는 복원)
        let pedometerStartDate: Date

        if wasRunning && existingSessionStart > 0 {
            // 기존 세션 복원 - 세션 시작 시간부터 다시 시작
            sessionStartTime = existingSessionStart
            pedometerStartDate = Date(timeIntervalSince1970: existingSessionStart / 1000)
            // 기존 저장된 걸음수는 무시하고 세션 시작 시간부터 다시 조회
            // (CMPedometer가 시스템 레벨에서 모든 걸음수를 추적하므로)
        } else {
            // 새 세션 시작
            sessionStartTime = Date().timeIntervalSince1970 * 1000
            pedometerStartDate = Date()
            userDefaults.set(true, forKey: sessionRunningKey)
            userDefaults.set(sessionStartTime, forKey: sessionStartTimeKey)
            userDefaults.set(0, forKey: totalSessionStepsKey)
            userDefaults.synchronize()

            // 이전 종료 시간이 있으면 히스토리 데이터 먼저 쿼리
            if let lastStop = userDefaults.object(forKey: lastStopTimeKey) as? Date {
                let semaphore = DispatchSemaphore(value: 0)
                pedometer.queryPedometerData(from: lastStop, to: pedometerStartDate) { data, error in
                    if let data = data, error == nil {
                        baselineSteps = data.numberOfSteps.intValue
                    }
                    semaphore.signal()
                }
                _ = semaphore.wait(timeout: .now() + 2.0)
            }
        }

        // 실시간 업데이트 시작 (세션 시작 시간부터)
        pedometer.startUpdates(from: pedometerStartDate) { [weak self] data, error in
            guard let self = self else { return }

            if let error = error {
                self.notifyListeners("stepUpdate", data: [
                    "error": error.localizedDescription
                ])
                return
            }

            if let data = data {
                let totalSteps = baselineSteps + data.numberOfSteps.intValue

                // 현재 걸음수 저장 (앱 재시작 시 복원용)
                self.userDefaults.set(totalSteps, forKey: self.totalSessionStepsKey)

                self.notifyListeners("stepUpdate", data: [
                    "steps": totalSteps,
                    "timestamp": Date().timeIntervalSince1970 * 1000,
                    "distance": data.distance?.doubleValue ?? 0,
                    "floorsAscended": data.floorsAscended?.intValue ?? 0,
                    "floorsDescended": data.floorsDescended?.intValue ?? 0,
                    "currentPace": data.currentPace?.doubleValue ?? 0,
                    "currentCadence": data.currentCadence?.doubleValue ?? 0,
                    "historicalSteps": baselineSteps,
                    "liveSteps": data.numberOfSteps.intValue
                ])
            }
        }

        call.resolve([
            "started": true,
            "historicalSteps": baselineSteps,
            "sessionStartTime": sessionStartTime
        ])
    }

    @objc func stopUpdates(_ call: CAPPluginCall) {
        pedometer.stopUpdates()

        // 세션 종료 상태 저장
        userDefaults.set(false, forKey: sessionRunningKey)

        // 종료 시간 저장
        let stopTime = Date()
        userDefaults.set(stopTime, forKey: lastStopTimeKey)
        userDefaults.synchronize()

        call.resolve([
            "stopped": true,
            "stopTime": stopTime.timeIntervalSince1970 * 1000
        ])
    }

    @objc func queryHistoricalData(_ call: CAPPluginCall) {
        guard let startTimeMs = call.getDouble("startTime") else {
            call.reject("Missing startTime parameter")
            return
        }

        let endTimeMs = call.getDouble("endTime") ?? Date().timeIntervalSince1970 * 1000

        let startDate = Date(timeIntervalSince1970: startTimeMs / 1000)
        let endDate = Date(timeIntervalSince1970: endTimeMs / 1000)

        pedometer.queryPedometerData(from: startDate, to: endDate) { data, error in
            if let error = error {
                call.reject("Query failed: \(error.localizedDescription)")
                return
            }

            if let data = data {
                call.resolve([
                    "steps": data.numberOfSteps.intValue,
                    "distance": data.distance?.doubleValue ?? 0,
                    "floorsAscended": data.floorsAscended?.intValue ?? 0,
                    "floorsDescended": data.floorsDescended?.intValue ?? 0,
                    "startTime": startTimeMs,
                    "endTime": endTimeMs
                ])
            } else {
                call.resolve([
                    "steps": 0,
                    "distance": 0,
                    "startTime": startTimeMs,
                    "endTime": endTimeMs
                ])
            }
        }
    }

    @objc func getServiceStatus(_ call: CAPPluginCall) {
        let isRunning = userDefaults.bool(forKey: sessionRunningKey)
        let sessionStartTime = userDefaults.double(forKey: sessionStartTimeKey)
        let currentSteps = userDefaults.integer(forKey: totalSessionStepsKey)

        call.resolve([
            "isRunning": isRunning,
            "currentSteps": currentSteps,
            "sessionStartTime": sessionStartTime
        ])
    }
}
