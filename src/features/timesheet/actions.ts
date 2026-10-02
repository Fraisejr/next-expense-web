import type { Dispatch, SetStateAction } from 'react'
import type { AppData, TimeCode, TimesheetClient, TimesheetClientForecast, TimesheetClientRate } from '../../types'

type TimesheetApi = typeof import('./api')
export type TimesheetActionServices = Pick<TimesheetApi,
  | 'createTimeCode'
  | 'updateTimeCode'
  | 'createTimesheetClient'
  | 'updateTimesheetClient'
  | 'saveTimesheetClientRate'
  | 'saveTimesheetClientForecast'
  | 'saveTimeCodeOrder'
> & {
  uid: () => string
  todayInParis: () => string
}

export function createTimesheetActions(
  workspaceId: string,
  data: Pick<AppData, 'timeCodes' | 'timesheetClients'>,
  setWrittenData: Dispatch<SetStateAction<AppData>>,
  services: TimesheetActionServices,
) {
  async function addTimeCode(name: string, clientId: string) {
    if (!clientId) throw new Error('Choose a client for this time code.')
    const code: TimeCode = { id: services.uid(), name: name.normalize('NFKC').trim(), sortOrder: data.timeCodes.length, clientId }
    await services.createTimeCode(workspaceId, code)
    setWrittenData((current) => ({ ...current, timeCodes: [...current.timeCodes, code] }))
  }

  async function changeTimeCode(code: TimeCode) {
    await services.updateTimeCode(workspaceId, code)
    setWrittenData((current) => ({ ...current, timeCodes: current.timeCodes.map((item) => item.id === code.id ? code : item) }))
  }

  async function addTimesheetClient(name: string, currency: string, hourlyRateMinor: number) {
    const year = Number(services.todayInParis().slice(0, 4))
    const client: TimesheetClient = { id: services.uid(), name: name.normalize('NFKC').trim(), currency: currency.toUpperCase(), sortOrder: data.timesheetClients.length, active: true }
    const rate: TimesheetClientRate = { clientId: client.id, effectiveFrom: `${year}-01-01`, hourlyRateMinor }
    await services.createTimesheetClient(workspaceId, client, rate)
    setWrittenData((current) => ({
      ...current,
      timesheetClients: [...current.timesheetClients, client],
      timesheetClientRates: [...current.timesheetClientRates, rate],
    }))
  }

  async function changeTimesheetClient(client: TimesheetClient) {
    await services.updateTimesheetClient(workspaceId, client)
    setWrittenData((current) => ({ ...current, timesheetClients: current.timesheetClients.map((item) => item.id === client.id ? client : item) }))
  }

  async function changeTimesheetClientRate(rate: TimesheetClientRate) {
    await services.saveTimesheetClientRate(workspaceId, rate)
    setWrittenData((current) => ({
      ...current,
      timesheetClientRates: [...current.timesheetClientRates.filter((item) => item.clientId !== rate.clientId || item.effectiveFrom !== rate.effectiveFrom), rate],
    }))
  }

  async function changeTimesheetClientForecast(forecast: TimesheetClientForecast) {
    await services.saveTimesheetClientForecast(workspaceId, forecast)
    setWrittenData((current) => ({
      ...current,
      timesheetClientForecasts: [...current.timesheetClientForecasts.filter((item) => item.clientId !== forecast.clientId || item.year !== forecast.year), forecast],
    }))
  }

  async function reorderTimeCodes(timeCodeIds: string[]) {
    const requestedIds = new Set(timeCodeIds)
    const reordered = [
      ...timeCodeIds.flatMap((id) => {
        const code = data.timeCodes.find((item) => item.id === id)
        return code ? [code] : []
      }),
      ...data.timeCodes.filter((code) => !requestedIds.has(code.id)),
    ].map((code, sortOrder) => ({ ...code, sortOrder }))
    await services.saveTimeCodeOrder(workspaceId, reordered.map((code) => code.id))
    setWrittenData((current) => ({ ...current, timeCodes: reordered }))
  }

  return { addTimeCode, changeTimeCode, addTimesheetClient, changeTimesheetClient, changeTimesheetClientRate, changeTimesheetClientForecast, reorderTimeCodes }
}
