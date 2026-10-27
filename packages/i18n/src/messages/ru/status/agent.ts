import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.claudeWriteOutside":
    "Запись в {path} — за пределами рабочего пространства агента, общей папки и временных папок.",
  "status.agent.contextCleared": "Контекст очищен. Здесь начинается новый чат.",
  "status.agent.modelSwitchedForLimit": "Лимит использования исчерпан. Переключено на {model}.",
  "status.agent.modelReturnedAfterLimit": "Лимит использования обновился. Снова используется {model}.",
  "status.agent.pausedHourBudget":
    "Лимит токенов достигнут: {used} токенов за последний час (лимит {limit}). Новая работа ждёт, пока вы не продолжите.",
  "status.agent.pausedTurnBudget":
    "Остановлено после шага: этот ход израсходовал {used} токенов (лимит {limit}). Работа сохранена. Продолжите, чтобы идти дальше.",
  "status.agent.pausedPlanLimit":
    "Лимит плана остановил этот ход. Работа сохранена и продолжится, когда лимит закончится.",
  "status.agent.marketplaceSuggested": "Предложено приложение из каталога: {app}.",
  "status.agent.screenCaptureScreen": "Сделать снимок главного экрана и отправить изображение модели агента.",
  "status.agent.screenCaptureDisplay": "Сделать снимок дисплея {name} и отправить изображение модели агента.",
  "status.agent.screenCaptureWindow": "Сделать снимок окна {name} и отправить изображение модели агента.",
  "status.agent.screenCaptureRegion":
    "Сделать снимок области экрана {x}, {y}, {width} × {height} точек и отправить изображение модели агента.",
  "status.agent.screenCaptureProgress": "Запрос снимка экрана…",
  "status.agent.screenCaptureReviewing": "Просмотр снимка экрана…",
  "status.agent.starting": "Запуск локальных CLI агентов…",
} as const satisfies PartialTranslation<typeof source>;
