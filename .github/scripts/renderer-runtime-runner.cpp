#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QTimer>
#include <QUrl>

int main(int argc, char **argv)
{
    QGuiApplication app(argc, argv);
    app.setQuitOnLastWindowClosed(false);

    if (argc != 2) {
        qCritical("usage: renderer-runtime-runner <test.qml>");
        return 64;
    }

    QQmlApplicationEngine engine;
    engine.load(QUrl::fromLocalFile(QString::fromLocal8Bit(argv[1])));
    if (engine.rootObjects().isEmpty()) {
        qCritical("QML engine did not create a root object");
        return 1;
    }

    QTimer::singleShot(30000, &app, [&app] {
        qCritical("QML lifecycle test timed out");
        app.exit(124);
    });
    const int appResult = app.exec();
    QObject *root = engine.rootObjects().isEmpty() ? nullptr : engine.rootObjects().first();
    if (!root || !root->property("testCompleted").toBool()) {
        qCritical("QML lifecycle test exited without completing its assertions");
        return 1;
    }
    return root->property("testExitCode").toInt() != 0 ? root->property("testExitCode").toInt() : appResult;
}
