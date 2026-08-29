import asyncio
import re
import sys

import httpx


def is_valid_ip(ip):
    """Validate IP address format"""
    ipv4_pattern = r"^(\d{1,3}\.){3}\d{1,3}$"
    ipv6_pattern = r"^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$"
    return bool(re.match(ipv4_pattern, ip) or re.match(ipv6_pattern, ip))


def is_valid_domain(domain):
    """Validate domain format"""
    domain_pattern = r"^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$"
    return bool(re.match(domain_pattern, domain))


async def get_ip_info(ip_or_domain):
    """Get IP information from ip-api.com"""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            url = f"http://ip-api.com/json/{ip_or_domain}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,query,reverse,mobile,proxy,hosting"
            response = await client.get(url)
            data = response.json()

            if data.get("status") == "fail":
                return None, data.get("message", "خطا در دریافت اطلاعات")

            return data, None
    except Exception as e:
        return None, str(e)


async def ping_ip(ip, count=4):
    """Ping an IP address and return results"""
    try:
        # Determine ping command based on OS
        if sys.platform == "win32":
            cmd = ["ping", "-n", str(count), "-w", "3000", ip]
        else:
            cmd = ["ping", "-c", str(count), "-W", "3", ip]

        process = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )

        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=15.0)

        output = stdout.decode("utf-8", errors="ignore")

        # Check if ping was successful
        if process.returncode == 0:
            # Extract average/min/max time from output
            if sys.platform == "win32":
                # Windows format: Minimum = Xms, Maximum = Yms, Average = Zms
                avg_match = re.search(r"Average\s*=\s*(\d+)ms", output)
                min_match = re.search(r"Minimum\s*=\s*(\d+)ms", output)
                max_match = re.search(r"Maximum\s*=\s*(\d+)ms", output)
            else:
                # Linux/Mac format
                avg_match = re.search(r"min/avg/max[^=]*=\s*([\d.]+)/([\d.]+)/([\d.]+)", output)
                min_match = None
                max_match = None

            if avg_match:
                if sys.platform == "win32":
                    avg_time = avg_match.group(1)
                    min_time = min_match.group(1) if min_match else "N/A"
                    max_time = max_match.group(1) if max_match else "N/A"
                    return True, f"میانگین: {avg_time}ms | حداقل: {min_time}ms | حداکثر: {max_time}ms"
                min_time = avg_match.group(1)
                avg_time = avg_match.group(2)
                max_time = avg_match.group(3)
                return True, f"میانگین: {avg_time}ms | حداقل: {min_time}ms | حداکثر: {max_time}ms"

            return True, "پینگ موفق بود"
        return False, "پینگ ناموفق - IP در دسترس نیست"

    except TimeoutError:
        return False, "زمان انتظار به پایان رسید"
    except Exception as e:
        return False, f"خطا: {e!s}"
