import datetime

def main():
    now = datetime.datetime.now()
    print(f"🦞 Hello from Claude Code!")
    print(f"当前时间：{now.strftime('%Y-%m-%d %H:%M:%S')}")

if __name__ == "__main__":
    main()
