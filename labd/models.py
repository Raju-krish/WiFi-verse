"""Validated lab topology. Everything that reaches a config file or a command line is constrained here."""
from enum import Enum
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NodeId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9]{0,7}$")]
Coord = Annotated[float, Field(ge=-1000, le=1000)]
Channel = Literal[1, 6, 11]
MAX_APS, MAX_STAS, MAX_SNIFFERS = 6, 6, 4


class Security(str, Enum):
    open = "open"
    owe = "owe"
    wpa2 = "wpa2-psk"
    wpa3 = "wpa3-sae"
    ft = "ft-psk"


class _Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: NodeId
    x: Coord = 0
    y: Coord = 0


class Ap(_Node):
    kind: Literal["ap"] = "ap"
    channel: Channel = 1
    tx_dbm: int = Field(default=10, ge=0, le=30)


class Sta(_Node):
    kind: Literal["sta"] = "sta"
    tx_dbm: int = Field(default=10, ge=0, le=30)
    roam_threshold_dbm: int = Field(default=-65, ge=-90, le=-40)


class Sniffer(_Node):
    kind: Literal["sniffer"] = "sniffer"
    channel: Channel = 1


Node = Annotated[Union[Ap, Sta, Sniffer], Field(discriminator="kind")]


class Topology(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="lab", pattern=r"^[A-Za-z0-9 _.-]{1,40}$")
    ssid: str = Field(default="LabNet", pattern=r"^[A-Za-z0-9 _.-]{1,32}$")
    passphrase: str = Field(default="labpassword123", pattern=r"^[A-Za-z0-9!#$%&()*+,./:;<=>?@\[\]^_{|}~-]{8,63}$")
    security: Security = Security.ft
    ft_keys: Literal["local", "pull", "push"] = "local"  # how a target AP obtains PMK-R1 (FT-PSK only)
    ft_over_ds: bool = False
    auto_stop_capture: bool = False  # stop recording once the client has finished roaming
    pause_capture_when_connected: bool = False  # stop recording a few seconds after the client connects; resumes on reconnect
    fault: Literal["none", "wrong_password", "mac_blocked", "pmf_mismatch", "security_mismatch"] = "none"  # a deliberate mistake
    path_loss_exponent: float = Field(default=3.5, ge=2.0, le=6.0)
    nodes: list[Node]

    @field_validator("nodes")
    @classmethod
    def unique_ids(cls, nodes: list) -> list:
        ids = [n.id for n in nodes]
        if len(set(ids)) != len(ids):
            raise ValueError("node ids must be unique")
        return nodes

    @model_validator(mode="after")
    def limits(self) -> "Topology":
        n = {k: sum(1 for x in self.nodes if x.kind == k) for k in ("ap", "sta", "sniffer")}
        if n["ap"] < 1:
            raise ValueError("at least one AP is required")
        if n["ap"] > MAX_APS or n["sta"] > MAX_STAS or n["sniffer"] > MAX_SNIFFERS:
            raise ValueError(f"limits: {MAX_APS} APs, {MAX_STAS} clients, {MAX_SNIFFERS} sniffers")
        if self.fault == "wrong_password" and self.security not in (Security.wpa2, Security.wpa3, Security.ft):
            raise ValueError("a wrong password needs a security mode with a password")
        if self.fault == "pmf_mismatch" and self.security != Security.wpa2:
            raise ValueError("the PMF mismatch is built on WPA2-Personal")
        return self

    def ordered(self) -> list:
        """Radio order: APs, then clients, then sniffers. wmediumd indexes follow this order."""
        rank = {"ap": 0, "sta": 1, "sniffer": 2}
        return sorted(self.nodes, key=lambda n: rank[n.kind])


PRESETS = {
    "two-ap-roam": Topology(
        name="Two APs and one walking client",
        security=Security.ft,
        nodes=[
            Ap(id="ap1", x=0, y=0, channel=1),
            Ap(id="ap2", x=40, y=0, channel=6),
            Sta(id="sta1", x=2, y=0),
            Sniffer(id="snf1", x=20, y=6, channel=1),
        ],
    ),
}
